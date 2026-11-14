// ============================================================================
// CINE POMPEIA — CLOUDFLARE WORKER API & GOOGLE DRIVE STREAMING PROXY
// Executa na borda da Cloudflare para atender /api/* no deploy *.workers.dev
// ============================================================================

const metaCache = new Map();
const META_CACHE_TTL_MS = 10 * 60 * 1000;

function isValidDriveFileId(fileId) {
  return /^[a-zA-Z0-9_-]{20,60}$/.test(String(fileId || '').trim());
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

async function getCatalogFromAssets(env, requestUrl) {
  try {
    if (env && env.ASSETS) {
      const assetUrl = new URL('/drive_catalog.json', requestUrl);
      const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
      if (res.ok) {
        return await res.json();
      }
    }
  } catch (_) {}
  return { folders: [], movies: [] };
}

async function getDriveFileMetadata(fileId, env) {
  const cached = metaCache.get(fileId);
  if (cached && Date.now() - cached.cachedAt < META_CACHE_TTL_MS) {
    return cached.meta;
  }

  const googleApiKey = (env && env.GOOGLE_DRIVE_API_KEY ? env.GOOGLE_DRIVE_API_KEY : '').trim();
  const googleOAuthToken = (env && env.GOOGLE_OAUTH_ACCESS_TOKEN ? env.GOOGLE_OAUTH_ACCESS_TOKEN : '').trim();

  if (googleApiKey || googleOAuthToken) {
    try {
      const apiUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      apiUrl.searchParams.set('fields', 'id,name,mimeType,size,capabilities(canDownload)');
      apiUrl.searchParams.set('supportsAllDrives', 'true');
      if (googleApiKey && !googleOAuthToken) {
        apiUrl.searchParams.set('key', googleApiKey);
      }
      const headers = {};
      if (googleOAuthToken) headers.Authorization = `Bearer ${googleOAuthToken}`;

      const apiRes = await fetch(apiUrl.toString(), { headers });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const meta = {
          id: data.id,
          name: data.name || `${fileId}.mp4`,
          mimeType: inferMimeType(data.name, data.mimeType),
          size: Number(data.size || 0),
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
      canDownload: totalSize > 0,
      source: 'drive_public_head'
    };
    metaCache.set(fileId, { meta, cachedAt: Date.now() });
    return meta;
  } catch (err) {
    return { errorStatus: 502, error: 'Falha ao consultar arquivo no Google Drive: ' + err.message };
  }
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
  const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB por bloco para streaming progressivo rápido na borda
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
      'Cache-Control': 'private, max-age=3600'
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

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

    // 3. Catálogo do Drive
    if (path === '/api/drive/catalog') {
      const cat = await getCatalogFromAssets(env, request.url);
      return jsonResponse({
        totalMovies: (cat.movies || []).length,
        folders: cat.folders || [],
        movies: cat.movies || []
      });
    }

    // 4. Sincronizar pasta do Google Drive
    if (path === '/api/drive/sync-folder' && request.method === 'POST') {
      try {
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
            400
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
        const defaultCategory = (body && body.defaultCategory) || 'Auto';
        const movies = discoveredFiles.map((file, idx) => {
          const parsed = parseMovieFilename(file.fileName);
          return {
            id: `drive_${file.fileId}`,
            title: parsed.title,
            year: parsed.year,
            rating: '8.5',
            category: defaultCategory !== 'Auto' ? defaultCategory : 'Filmes do Google Drive',
            featured: idx === 0,
            driveFileId: file.fileId,
            rawUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
            streamUrl: `/api/gdrive/stream/${file.fileId}`,
            poster: `https://placehold.co/500x750/151828/f5c518?text=${encodeURIComponent(parsed.title)}`,
            backdrop: '',
            overview: `Arquivo sincronizado da sua pasta do Google Drive (${file.fileName}).`,
            addedAt: Date.now() - idx
          };
        });
        return jsonResponse({
          success: true,
          discoveredCount: discoveredFiles.length,
          addedCount: movies.length,
          totalMovies: movies.length,
          movies
        });
      } catch (err) {
        return jsonResponse({ error: 'Erro ao sincronizar pasta: ' + err.message }, 500);
      }
    }

    // 5. Salas ativas (no modo Serverless a sala roda via WebRTC P2P)
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
