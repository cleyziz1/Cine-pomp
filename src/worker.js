// ============================================================================
// CINE POMPEIA — CLOUDFLARE WORKER API, RBAC, SYNC & GOOGLE DRIVE STREAMING PROXY
// Executa na borda da Cloudflare para atender /api/* no deploy *.workers.dev
// ============================================================================

const metaCache = new Map();
const codecProbeCache = new Map();
const revokedTokens = new Set();
const META_CACHE_TTL_MS = 10 * 60 * 1000;

// Estado em memória do isolate (sincronizado com ASSETS/drive_catalog.json)
let runtimeCatalog = null;

function isValidDriveFileId(fileId) {
  return /^[a-zA-Z0-9_-]{20,60}$/.test(String(fileId || '').trim());
}

function extractDriveFileId(input) {
  const str = String(input || '').trim();
  if (!str) return null;
  if (/^[a-zA-Z0-9_-]{25,55}$/.test(str)) return str;
  const m1 = str.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return m1[1];
  const m2 = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return m2[1];
  return null;
}

function extractDriveFolderId(input) {
  const str = String(input || '').trim();
  if (!str) return null;
  if (/^[a-zA-Z0-9_-]{25,55}$/.test(str)) return str;
  const matchFolder = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (matchFolder && matchFolder[1]) return matchFolder[1];
  const matchIdParam = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (matchIdParam && matchIdParam[1]) return matchIdParam[1];
  return null;
}

function inferMimeType(nameOrDisposition, apiMimeType) {
  if (apiMimeType && apiMimeType.startsWith('video/')) {
    if (apiMimeType === 'video/x-matroska') return 'video/mp4';
    return apiMimeType;
  }
  const str = String(nameOrDisposition || '').toLowerCase();
  if (str.includes('.webm')) return 'video/webm';
  if (str.includes('.ogg') || str.includes('.ogv')) return 'video/ogg';
  return 'video/mp4';
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

// ============================================================================
// FASE 1 — RBAC: AUTENTICAÇÃO E AUTORIZAÇÃO DE ADMINISTRADOR (Web Crypto HMAC)
// ============================================================================
function getAdminPassword(env) {
  return (env && env.ADMIN_PASSWORD ? String(env.ADMIN_PASSWORD) : 'admin-pompeia-2026').trim();
}

function getAdminSecret(env) {
  return (env && env.ADMIN_TOKEN_SECRET ? String(env.ADMIN_TOKEN_SECRET) : `${getAdminPassword(env)}::cine_pompeia_rbac_v1`).trim();
}

function toBase64Url(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.byteLength; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signHmac(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

async function createAdminToken(env) {
  const payload = {
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000,
    jti: Math.random().toString(36).slice(2) + Date.now().toString(36)
  };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await signHmac(payloadB64, getAdminSecret(env));
  return `${payloadB64}.${sig}`;
}

function extractBearerToken(request) {
  const auth = request.headers.get('authorization') || request.headers.get('x-admin-token') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (auth.includes('.')) return auth.trim();
  return '';
}

async function verifyAdminRequest(request, env) {
  const token = extractBearerToken(request);
  if (!token || revokedTokens.has(token)) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  const expectedSig = await signHmac(payloadB64, getAdminSecret(env));
  if (sig !== expectedSig) return false;
  try {
    const jsonStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(jsonStr);
    if (!payload || payload.role !== 'admin' || !payload.exp || Date.now() > payload.exp) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function getCatalog(env, requestUrl) {
  if (runtimeCatalog && Array.isArray(runtimeCatalog.movies)) {
    return runtimeCatalog;
  }
  try {
    if (env && env.ASSETS) {
      const assetUrl = new URL('/drive_catalog.json', requestUrl);
      const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
      if (res.ok) {
        const parsed = await res.json();
        runtimeCatalog = {
          folders: Array.isArray(parsed.folders) ? parsed.folders : [],
          removedMovies: Array.isArray(parsed.removedMovies) ? parsed.removedMovies : [],
          lastReconciledAt: parsed.lastReconciledAt || null,
          movies: Array.isArray(parsed.movies) ? parsed.movies : []
        };
        return runtimeCatalog;
      }
    }
  } catch (_) {}
  runtimeCatalog = { folders: [], removedMovies: [], lastReconciledAt: null, movies: [] };
  return runtimeCatalog;
}

async function getDriveFileMetadata(fileId, env, options = {}) {
  const { bypassCache = false } = options;
  if (!bypassCache) {
    const cached = metaCache.get(fileId);
    if (cached && Date.now() - cached.cachedAt < META_CACHE_TTL_MS) {
      return cached.meta;
    }
  }

  const googleApiKey = (env && env.GOOGLE_DRIVE_API_KEY ? env.GOOGLE_DRIVE_API_KEY : '').trim();
  const googleOAuthToken = (env && env.GOOGLE_OAUTH_ACCESS_TOKEN ? env.GOOGLE_OAUTH_ACCESS_TOKEN : '').trim();

  if (googleApiKey || googleOAuthToken) {
    try {
      const apiUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      apiUrl.searchParams.set('fields', 'id,name,mimeType,size,trashed,parents,capabilities(canDownload)');
      apiUrl.searchParams.set('supportsAllDrives', 'true');
      if (googleApiKey && !googleOAuthToken) {
        apiUrl.searchParams.set('key', googleApiKey);
      }
      const headers = {};
      if (googleOAuthToken) headers.Authorization = `Bearer ${googleOAuthToken}`;

      const apiRes = await fetch(apiUrl.toString(), { headers });
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data.trashed) {
          return { errorStatus: 404, trashed: true, error: 'Arquivo está na lixeira do Google Drive.' };
        }
        const meta = {
          id: data.id,
          name: data.name || `${fileId}.mp4`,
          mimeType: inferMimeType(data.name, data.mimeType),
          size: Number(data.size || 0),
          trashed: Boolean(data.trashed),
          canDownload: data.capabilities ? data.capabilities.canDownload !== false : true,
          source: 'drive_api_v3'
        };
        metaCache.set(fileId, { meta, cachedAt: Date.now() });
        return meta;
      }
      if (apiRes.status === 404 || apiRes.status === 403 || apiRes.status === 401) {
        return { errorStatus: apiRes.status, error: 'Arquivo não encontrado ou sem permissão na Google Drive API v3.' };
      }
    } catch (_) {}
  }

  try {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
      fileId
    )}&export=download&confirm=t`;
    const r = await fetch(downloadUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Range: 'bytes=0-0'
      },
      redirect: 'follow'
    });

    if (r.status === 404) {
      return { errorStatus: 404, error: 'Arquivo não encontrado no Google Drive.' };
    }
    if (r.status === 401 || r.status === 403) {
      return { errorStatus: 403, error: 'Acesso negado ao arquivo do Google Drive.' };
    }
    if (r.status >= 500 || r.status === 429) {
      return { errorStatus: r.status, error: 'Erro temporário no servidor do Google Drive.' };
    }

    const cr = r.headers.get('content-range') || '';
    const cd = r.headers.get('content-disposition') || '';
    const ct = r.headers.get('content-type') || '';

    if (ct.includes('text/html') && !cr) {
      return { errorStatus: 403, error: 'Arquivo não está público ou exige autenticação no Google Drive.' };
    }

    const sizeMatch = cr.match(/\/(\d+)/);
    const totalSize = sizeMatch ? Number(sizeMatch[1]) : 0;
    const filenameMatch = cd.match(/filename="([^"]+)"/i);
    const fileName = filenameMatch ? filenameMatch[1] : `${fileId}.mp4`;

    const meta = {
      id: fileId,
      name: fileName,
      mimeType: inferMimeType(fileName, ct),
      size: totalSize,
      trashed: false,
      canDownload: totalSize > 0,
      source: 'drive_public_head'
    };
    metaCache.set(fileId, { meta, cachedAt: Date.now() });
    return meta;
  } catch (err) {
    return { errorStatus: 502, error: 'Falha ao consultar arquivo no Google Drive: ' + err.message };
  }
}

async function probeMediaCodecsWorker(fileId, env) {
  if (codecProbeCache.has(fileId)) return codecProbeCache.get(fileId);
  const meta = await getDriveFileMetadata(fileId, env);
  if (meta.errorStatus) return { errorStatus: meta.errorStatus, error: meta.error };

  const fileName = meta.name || `${fileId}.mp4`;
  const lowerName = fileName.toLowerCase();
  let ascii = '';

  try {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
      fileId
    )}&export=download&confirm=t`;
    const r = await fetch(downloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Range: 'bytes=0-262143'
      },
      redirect: 'follow'
    });
    if (r.ok || r.status === 206) {
      const bytes = new Uint8Array(await r.arrayBuffer());
      const chunk = [];
      for (let i = 0; i < bytes.length; i += 8192) {
        chunk.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
      }
      ascii = chunk.join('');
    }
  } catch (_) {}

  let container = 'mp4';
  if (ascii.startsWith('\x1a\x45\xdf\xa3')) {
    container = ascii.toLowerCase().includes('webm') || lowerName.endsWith('.webm') ? 'webm' : 'mkv';
  } else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') {
    container = 'avi';
  } else if (lowerName.endsWith('.mkv')) {
    container = 'mkv';
  } else if (lowerName.endsWith('.webm')) {
    container = 'webm';
  } else if (lowerName.endsWith('.avi')) {
    container = 'avi';
  }

  const videoCodecs = [];
  if (ascii.includes('V_MPEG4/ISO/AVC') || ascii.includes('avc1') || /\bh\.?264|x264\b/i.test(fileName)) {
    videoCodecs.push('H.264 (AVC)');
  }
  if (ascii.includes('V_MPEGH/ISO/HEVC') || ascii.includes('hev1') || /\bh\.?265|x265|hevc\b/i.test(fileName)) {
    videoCodecs.push('H.265 (HEVC)');
  }
  if (ascii.includes('V_VP9') || ascii.includes('vp09')) videoCodecs.push('VP9');
  if (videoCodecs.length === 0) videoCodecs.push(container === 'avi' ? 'MPEG-4 Visual (AVI)' : 'H.264 (AVC)');

  const audioCodecs = [];
  if (ascii.includes('A_AAC') || ascii.includes('mp4a')) audioCodecs.push('AAC');
  if (ascii.includes('A_AC3') || ascii.includes('ac-3') || /\bac-?3\b/i.test(fileName)) {
    audioCodecs.push('AC-3 (Dolby Digital 5.1)');
  }
  if (ascii.includes('A_EAC3') || ascii.includes('ec-3') || /\be-?ac-?3\b/i.test(fileName)) {
    audioCodecs.push('E-AC-3 (Dolby Digital Plus)');
  }
  if (ascii.includes('A_DTS') || /\bdts\b/i.test(fileName)) audioCodecs.push('DTS');
  if (ascii.includes('A_OPUS') || ascii.includes('Opus')) audioCodecs.push('Opus');
  if (ascii.includes('A_VORBIS')) audioCodecs.push('Vorbis');
  if (audioCodecs.length === 0) audioCodecs.push(container === 'webm' ? 'Opus/Vorbis' : 'AAC');

  const isDualAudio = /\b(dual|dublado|multi)\b/i.test(fileName);
  const hasBrowserCompatibleAudioTrack =
    container !== 'avi' &&
    (audioCodecs.includes('AAC') ||
      audioCodecs.includes('Opus') ||
      audioCodecs.includes('Vorbis') ||
      audioCodecs.includes('Opus/Vorbis'));

  const diag = {
    fileId,
    fileName,
    size: meta.size,
    container,
    videoCodecs,
    audioCodecs,
    audioTrackCount: isDualAudio ? 2 : 1,
    isDualAudio,
    languages: isDualAudio
      ? [
          { code: 'pt-BR', label: 'Português (Brasil)' },
          { code: 'en', label: 'Inglês (Original)' }
        ]
      : [{ code: 'pt-BR', label: 'Áudio Principal' }],
    browserVideoSupported: container !== 'avi' && !videoCodecs.includes('H.265 (HEVC)'),
    browserAudioSupported: hasBrowserCompatibleAudioTrack,
    requiresAudioFallbackOrRemux: !hasBrowserCompatibleAudioTrack,
    diagnosticReason: hasBrowserCompatibleAudioTrack
      ? `Áudio ${audioCodecs.join(' / ')} compatível nativamente com navegadores HTML5.`
      : `O arquivo utiliza áudio ${audioCodecs.join(', ')} em contêiner ${container.toUpperCase()}, que não é decodificado nativamente pela tag <video> sem transcodificação/player compatível.`
  };
  codecProbeCache.set(fileId, diag);
  return diag;
}

async function handleStream(request, env, fileId) {
  if (!isValidDriveFileId(fileId)) {
    return jsonResponse({ error: 'ID de arquivo inválido.' }, 400);
  }

  const meta = await getDriveFileMetadata(fileId, env);
  if (meta.errorStatus) {
    return jsonResponse({ error: meta.error }, meta.errorStatus);
  }
  if (!meta.canDownload || !meta.size) {
    return jsonResponse({ error: 'Arquivo sem permissão de download ou tamanho indisponível.' }, 403);
  }

  const totalSize = meta.size;
  const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
  const rangeHeader = request.headers.get('range');

  let start = 0;
  let end = Math.min(MAX_CHUNK_BYTES - 1, totalSize - 1);

  if (rangeHeader) {
    const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${totalSize}` }
      });
    }

    if (match[1] === '' && match[2] !== '') {
      const suffixLen = parseInt(match[2], 10);
      if (Number.isNaN(suffixLen) || suffixLen <= 0) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}` }
        });
      }
      start = Math.max(0, totalSize - suffixLen);
      end = totalSize - 1;
    } else {
      start = parseInt(match[1], 10);
      const requestedEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      if (
        Number.isNaN(start) ||
        Number.isNaN(requestedEnd) ||
        start < 0 ||
        start >= totalSize ||
        requestedEnd < start
      ) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}` }
        });
      }
      end = Math.min(requestedEnd, start + MAX_CHUNK_BYTES - 1, totalSize - 1);
    }
  }

  const googleOAuthToken = (env && env.GOOGLE_OAUTH_ACCESS_TOKEN ? env.GOOGLE_OAUTH_ACCESS_TOKEN : '').trim();
  const googleApiKey = (env && env.GOOGLE_DRIVE_API_KEY ? env.GOOGLE_DRIVE_API_KEY : '').trim();

  let upstreamUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId
  )}&export=download&confirm=t`;
  const upstreamHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Range: `bytes=${start}-${end}`
  };

  if (googleOAuthToken) {
    upstreamUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?alt=media&supportsAllDrives=true`;
    upstreamHeaders.Authorization = `Bearer ${googleOAuthToken}`;
  } else if (googleApiKey) {
    upstreamUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(googleApiKey)}`;
  }

  const upstream = await fetch(upstreamUrl, {
    headers: upstreamHeaders,
    redirect: 'follow'
  });

  if (!upstream.ok && upstream.status !== 206) {
    return jsonResponse({ error: 'Falha ao obter fluxo de vídeo do Google Drive.' }, upstream.status);
  }

  const upstreamType = upstream.headers.get('content-type') || '';
  if (upstreamType.includes('text/html')) {
    return jsonResponse(
      { error: 'O Google Drive retornou página de bloqueio em vez dos bytes do vídeo.' },
      403
    );
  }

  const chunkLen = end - start + 1;
  return new Response(upstream.body, {
    status: 206,
    headers: {
      'Content-Type': meta.mimeType,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(chunkLen),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function parseMovieFilename(filename) {
  let clean = String(filename || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\.(mp4|mkv|webm|avi|mov|m4v)$/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]/g, ' ')
    .replace(/^\s*\d{1,3}\s*[-.]\s*/, '');

  const yearMatch = clean.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : '';

  clean = clean
    .replace(
      /\b(open\s*matte|imax|remastered|1080p|720p|2160p|4k|blu-?ray|web-?dl|webrip|hdrip|x264|x265|h264|h265|hevc|aac|ac3|dual|dublado|legendado|pt-?br|5\.1|brshares)\b.*/i,
      ''
    )
    .replace(/\(\s*(19\d{2}|20\d{2})\s*\)/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(19\d{2}|20\d{2})\b/g, '')
    .replace(/[-–—]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: clean || filename,
    year: year || new Date().getFullYear().toString()
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 0. Autenticação e RBAC (/api/auth/*)
    if (path === '/api/auth/login' && request.method === 'POST') {
      try {
        const body = await request.json();
        const password = String((body && body.password) || '').trim();
        if (!password || password !== getAdminPassword(env)) {
          return jsonResponse({ error: 'Senha de administrador incorreta.' }, 401);
        }
        const token = await createAdminToken(env);
        return jsonResponse({ success: true, authenticated: true, role: 'admin', token });
      } catch (_) {
        return jsonResponse({ error: 'Requisição de login inválida.' }, 400);
      }
    }

    if (path === '/api/auth/me') {
      const isAdmin = await verifyAdminRequest(request, env);
      return jsonResponse({ authenticated: isAdmin, role: isAdmin ? 'admin' : 'user' });
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      const token = extractBearerToken(request);
      if (token) revokedTokens.add(token);
      return jsonResponse({ success: true, role: 'user' });
    }

    // 1. Streaming de vídeo (/api/videos/:id/stream ou /api/gdrive/stream/:fileId)
    const streamMatch =
      path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/stream$/) ||
      path.match(/^\/api\/gdrive\/stream\/([a-zA-Z0-9_-]+)$/);
    if (streamMatch) {
      return handleStream(request, env, streamMatch[1]);
    }

    // 2. Metadados do vídeo (/api/videos/:id/meta ou /api/gdrive/meta/:fileId)
    const metaMatch =
      path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/meta$/) ||
      path.match(/^\/api\/gdrive\/meta\/([a-zA-Z0-9_-]+)$/);
    if (metaMatch) {
      if (!isValidDriveFileId(metaMatch[1])) {
        return jsonResponse({ error: 'ID de arquivo inválido.' }, 400);
      }
      const meta = await getDriveFileMetadata(metaMatch[1], env);
      if (meta.errorStatus) return jsonResponse({ error: meta.error }, meta.errorStatus);
      return jsonResponse({ ...meta, fileId: meta.id });
    }

    // 2b. Diagnóstico de codecs de áudio e vídeo (/api/videos/:id/diagnostics)
    const diagMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/diagnostics$/);
    if (diagMatch) {
      if (!isValidDriveFileId(diagMatch[1])) {
        return jsonResponse({ error: 'ID de arquivo inválido.' }, 400);
      }
      const diag = await probeMediaCodecsWorker(diagMatch[1], env);
      if (diag.errorStatus) return jsonResponse({ error: diag.error }, diag.errorStatus);
      return jsonResponse(diag);
    }

    // 3. Catálogo do Drive (Leitura pública)
    if (path === '/api/drive/catalog' && request.method === 'GET') {
      const cat = await getCatalog(env, request.url);
      const visibleMovies = (cat.movies || []).filter((m) => !m.unavailable && !m.trashed);
      return jsonResponse({
        totalMovies: visibleMovies.length,
        folders: cat.folders || [],
        lastReconciledAt: cat.lastReconciledAt || null,
        movies: visibleMovies
      });
    }

    // 4. Rotas Administrativas Protegidas por RBAC
    if (path === '/api/drive/movies' && request.method === 'POST') {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: esta operação é restrita ao Administrador.' }, 403);
      }
      const cat = await getCatalog(env, request.url);
      const body = await request.json();
      const title = String((body && body.title) || '').trim();
      const rawUrl = String((body && body.rawUrl) || '').trim();
      if (!title || !rawUrl) {
        return jsonResponse({ error: 'Informe o título e o link do Google Drive.' }, 400);
      }
      const driveFileId = extractDriveFileId(rawUrl);
      const movieObj = {
        id: (body && body.id) || (driveFileId ? `drive_${driveFileId}` : `drive_${Date.now()}`),
        title,
        year: String((body && body.year) || new Date().getFullYear()),
        rating: String((body && body.rating) || '8.5'),
        category: String((body && body.category) || 'Lançamentos & Destaques'),
        featured: Boolean(body && body.featured),
        driveFileId,
        rawUrl,
        streamUrl: driveFileId ? `/api/gdrive/stream/${driveFileId}` : rawUrl,
        poster:
          (body && body.poster) ||
          `https://placehold.co/500x750/151828/f5c518?text=${encodeURIComponent(title)}`,
        backdrop: (body && body.backdrop) || (body && body.poster) || '',
        overview: (body && body.overview) || 'Filme armazenado no Google Drive.',
        addedAt: Date.now()
      };
      const existingIdx = cat.movies.findIndex((m) => m.id === movieObj.id);
      if (existingIdx >= 0) cat.movies[existingIdx] = movieObj;
      else cat.movies.unshift(movieObj);
      return jsonResponse({ success: true, movie: movieObj });
    }

    const movieItemMatch = path.match(/^\/api\/drive\/movies\/([^/]+)$/);
    if (movieItemMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: esta operação é restrita ao Administrador.' }, 403);
      }
      const cat = await getCatalog(env, request.url);
      const targetId = decodeURIComponent(movieItemMatch[1]);
      if (request.method === 'DELETE') {
        cat.movies = cat.movies.filter((m) => m.id !== targetId && m.driveFileId !== targetId);
        return jsonResponse({ success: true, removedId: targetId });
      }
      const idx = cat.movies.findIndex((m) => m.id === targetId);
      if (idx === -1) return jsonResponse({ error: 'Filme não encontrado.' }, 404);
      const updates = await request.json();
      cat.movies[idx] = { ...cat.movies[idx], ...updates, id: cat.movies[idx].id };
      return jsonResponse({ success: true, movie: cat.movies[idx] });
    }

    if (path === '/api/drive/sync-folder' && request.method === 'POST') {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: esta operação é restrita ao Administrador.' }, 403);
      }
      try {
        const cat = await getCatalog(env, request.url);
        const body = await request.json();
        const folderId = extractDriveFolderId(body && body.folderUrl);
        if (!folderId) {
          return jsonResponse({ error: 'Link de pasta inválido.' }, 400);
        }
        const embedUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
        const driveRes = await fetch(embedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!driveRes.ok) {
          return jsonResponse(
            { error: 'Não foi possível ler a pasta. Verifique se está compartilhada como "Qualquer pessoa com o link".' },
            driveRes.status >= 500 ? 503 : 400
          );
        }
        const html = await driveRes.text();
        const entryRegex = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
        const discoveredFiles = [];
        let m;
        while ((m = entryRegex.exec(html)) !== null) {
          const fileId = m[1];
          const fileName = m[2].trim();
          if (!/\.(jpg|jpeg|png|gif|srt|vtt|txt|nfo|pdf|zip|rar)$/i.test(fileName)) {
            discoveredFiles.push({ fileId, fileName });
          }
        }
        const discoveredIds = new Set(discoveredFiles.map((f) => f.fileId));
        const removedMovies = [];
        cat.movies = cat.movies.filter((mv) => {
          if (mv.driveFileId && !discoveredIds.has(mv.driveFileId)) {
            removedMovies.push({ id: mv.id, driveFileId: mv.driveFileId, title: mv.title });
            return false;
          }
          return true;
        });

        const defaultCategory = (body && body.defaultCategory) || 'Auto';
        let addedCount = 0;
        discoveredFiles.forEach((file, idx) => {
          if (cat.movies.some((mv) => mv.driveFileId === file.fileId)) return;
          const parsed = parseMovieFilename(file.fileName);
          cat.movies.unshift({
            id: `drive_${file.fileId}`,
            title: parsed.title,
            year: parsed.year,
            rating: '8.5',
            category: defaultCategory !== 'Auto' ? defaultCategory : 'Filmes do Google Drive',
            featured: idx === 0,
            driveFileId: file.fileId,
            folderId,
            rawUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
            streamUrl: `/api/gdrive/stream/${file.fileId}`,
            poster: `https://placehold.co/500x750/151828/f5c518?text=${encodeURIComponent(parsed.title)}`,
            backdrop: '',
            overview: `Arquivo sincronizado da sua pasta do Google Drive (${file.fileName}).`,
            addedAt: Date.now() - idx
          });
          addedCount += 1;
        });

        cat.lastReconciledAt = new Date().toISOString();
        return jsonResponse({
          success: true,
          discoveredCount: discoveredFiles.length,
          addedCount,
          removedCount: removedMovies.length,
          removedMovies,
          totalMovies: cat.movies.length,
          movies: cat.movies
        });
      } catch (err) {
        return jsonResponse({ error: 'Erro ao sincronizar pasta: ' + err.message }, 500);
      }
    }

    if (path === '/api/drive/reconcile' && request.method === 'POST') {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: esta operação é restrita ao Administrador.' }, 403);
      }
      const cat = await getCatalog(env, request.url);
      let body = {};
      try {
        body = await request.json();
      } catch (_) {}
      if (body && body.simulateTemporaryFailure) {
        return jsonResponse(
          {
            success: false,
            temporaryFailure: true,
            status: 503,
            message: 'Falha temporária ao comunicar com o Google Drive. Nenhum filme foi removido.',
            removedCount: 0,
            totalMovies: cat.movies.length
          },
          503
        );
      }

      const removedMovies = [];
      const surviving = [];
      for (const movie of cat.movies) {
        if (!movie.driveFileId) {
          surviving.push(movie);
          continue;
        }
        const meta = await getDriveFileMetadata(movie.driveFileId, env, { bypassCache: true });
        if (meta.errorStatus === 404 || meta.trashed) {
          removedMovies.push({
            id: movie.id,
            driveFileId: movie.driveFileId,
            title: movie.title,
            reason: 'file_deleted_or_trashed'
          });
          metaCache.delete(movie.driveFileId);
          continue;
        }
        surviving.push(movie);
      }
      cat.movies = surviving;
      cat.lastReconciledAt = new Date().toISOString();
      return jsonResponse({
        success: true,
        checkedCount: surviving.length + removedMovies.length,
        removedCount: removedMovies.length,
        removedMovies,
        totalMovies: cat.movies.length,
        movies: cat.movies
      });
    }

    // 5. Salas ativas
    if (path === '/api/rooms') {
      return jsonResponse([]);
    }

    // Demais rotas estáticas servidas pelos ASSETS (./public)
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
