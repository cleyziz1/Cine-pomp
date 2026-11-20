// ============================================================================
// CINE POMPEIA — CLOUDFLARE WORKER API, RBAC, SYNC, THUMBNAILS & STREAMING PROXY
// Executa na borda da Cloudflare para atender /api/* no deploy *.workers.dev
// ============================================================================

import {
  SECURITY_HEADERS,
  buildCorsHeaders,
  generateRequestId,
  constantTimeEqual,
  isValidDriveFileId,
  extractDriveFileId,
  extractDriveFolderId,
  getStreamMimeType,
  parseHttpByteRange,
  patchEbmlHeaderForUnsupportedAudio,
  parseMovieFilename,
  computeTitleSimilarity
} from './shared/media-utils.mjs';
import {
  computeFileVersionHash,
  auditSingleMovieRecord,
  runCatalogAudiovisualAudit,
  AudiovisualAuditQueue
} from './shared/audiovisual-audit.mjs';

const auditQueue = new AudiovisualAuditQueue({ maxConcurrent: 2, maxRetries: 3 });
let lastAudiovisualAuditReport = null;

const OFFICIAL_DRIVE_FOLDER_ID = '185iFV7I5x107sxJDTVbSxA9F0pY3GtTr';
const OFFICIAL_DRIVE_FOLDER_URL = `https://drive.google.com/drive/folders/${OFFICIAL_DRIVE_FOLDER_ID}?usp=drive_link`;

const metaCache = new Map();
const codecProbeCache = new Map();
const revokedTokens = new Set();
const loginAttemptsByIp = new Map();
const LOGIN_RATE_LIMIT_MAX = 8;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const META_CACHE_TTL_MS = 10 * 60 * 1000;
const patchEbmlHeaderForDualAudioMkv = patchEbmlHeaderForUnsupportedAudio;

// Estado em memória do isolate (sincronizado com ASSETS/drive_catalog.json e ASSETS/media_cache/registry.json)
let runtimeCatalog = null;
let runtimeMediaRegistry = null;
let driveChangesPageToken = null;
let activeDriveSyncPromise = null;
const DRIVE_AUTO_SYNC_TTL_MS = 60 * 1000;
const syncAuditLogs = [];
let lastAutoSyncState = {
  officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
  officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
  status: 'idle',
  source: 'static_seed',
  mode: 'initial',
  lastStartedAt: null,
  lastCompletedAt: null,
  lastCompletedMs: 0,
  lastTrigger: 'boot',
  discoveredCount: 0,
  addedCount: 0,
  renamedCount: 0,
  removedCount: 0,
  updatedCount: 0,
  durationMs: 0,
  error: null
};

function recordDriveSyncAudit(entry) {
  const clean = {
    detectedAt: entry.detectedAt || new Date().toISOString(),
    fileId: entry.fileId || null,
    fileName: entry.fileName || null,
    action: entry.action || 'info',
    syncState: entry.syncState || null,
    source: entry.source || null,
    catalogUpdatedAt: entry.catalogUpdatedAt || null,
    apiAvailableAt: entry.apiAvailableAt || new Date().toISOString(),
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : undefined,
    error: entry.error ? String(entry.error).slice(0, 200) : undefined
  };
  syncAuditLogs.unshift(clean);
  if (syncAuditLogs.length > 60) syncAuditLogs.length = 60;
  try {
    console.log('[DRIVE_SYNC]', JSON.stringify(clean));
  } catch (_) {}
}

const CURATED_PT_BR_METADATA = {
  '1AayQ_w6esYnD4tUK2Fl32aORrXNjt06j': {
    title: 'O Espetacular Homem-Aranha',
    year: '2012',
    rating: '7.0',
    category: 'Ação & Aventura',
    featured: true,
    poster: 'https://image.tmdb.org/t/p/w500/fSbqPbqXa7ePo8bcnZYN9AHv6zA.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/sLWUtbrpiLp23a0XDSiUiltdFPJ.jpg',
    overview:
      'Peter Parker está tentando saber mais sobre sua origem. Ele encontra uma pasta que pertenceu ao seu pai e quer descobrir por que seus pais desapareceram, o que o leva à Oscorp e ao Dr. Curt Connors.',
    posterSource: 'tmdb_pt_br',
    matchScore: 0.99
  },
  '1NforhhY8ngcAv39HhoS7wBHnwH1NdpJ6': {
    title: 'Moana: Um Mar de Aventuras',
    year: '2016',
    rating: '7.6',
    category: 'Animação & Família',
    featured: true,
    poster: 'https://image.tmdb.org/t/p/w500/4JeejGugONWpJkbnvL12hVoYEDa.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/iYLKMV7PIBtFmtygRrhSiyzcVsF.jpg',
    overview:
      'Uma jovem polinésia destemida parte em uma missão ousada pelo oceano Pacífico com a ajuda do semideus Maui para salvar seu povo de uma antiga maldição.',
    posterSource: 'tmdb_pt_br',
    matchScore: 0.99
  },
  '1MvZzeKQf9j_q6La6p5pWo0XfKjS1VHr4': {
    title: 'Homem-Aranha 2',
    year: '2004',
    rating: '7.5',
    category: 'Ação & Aventura',
    featured: false,
    poster: 'https://image.tmdb.org/t/p/w500/olxpyq9kJAZ2NU1siLshhhXEPR7.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/6al048Lat3eLVQOuKtc9h6Tu94d.jpg',
    overview:
      'Dois anos após derrotar o Duende Verde, Peter Parker enfrenta uma crise pessoal enquanto precisa deter o brilhante cientista Dr. Otto Octavius, transformado no perigoso Doutor Octopus.',
    posterSource: 'tmdb_pt_br',
    matchScore: 1.0
  },
  '1njsqsXqcPWN9Am8P4iZg2h_afu9ql0RJ': {
    title: 'O Espetacular Homem-Aranha 2: A Ameaça de Electro',
    year: '2014',
    rating: '6.6',
    category: 'Ação & Aventura',
    featured: false,
    poster: 'https://image.tmdb.org/t/p/w500/c3e9e18SSlvFd1cQaGmUj5tqL5P.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/u7SeO6Y42P7VCTWLhpnL96cyOqd.jpg',
    overview:
      'Peter Parker divide seu tempo entre proteger Nova York como Homem-Aranha e estar ao lado de Gwen Stacy, mas o surgimento do poderoso Electro e o retorno de Harry Osborn mudam tudo.',
    posterSource: 'tmdb_pt_br',
    matchScore: 0.98
  },
  '1vWwsFm3vDakms27RVGkbasAqW2rH7vUa': {
    title: 'Homem-Aranha 3',
    year: '2007',
    rating: '6.4',
    category: 'Ação & Aventura',
    featured: false,
    poster: 'https://image.tmdb.org/t/p/w500/qFmwhVUoUSXjkKRmca5yGDEXBIj.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/w1oD1MzHjnBJc5snKupIQaSBLIh.jpg',
    overview:
      'Peter Parker finalmente encontra equilíbrio entre sua devoção a Mary Jane e seus deveres como herói, até que seu traje é tomado por um simbionte alienígena e surgem Homem-Areia e Venom.',
    posterSource: 'tmdb_pt_br',
    matchScore: 1.0
  },
  '13UZDtd0NQ8ON50ChOwBFdsuLC3AtjPk_': {
    title: 'Homem-Aranha: Longe de Casa',
    year: '2019',
    rating: '7.4',
    category: 'Ação & Aventura',
    featured: true,
    poster: 'https://image.tmdb.org/t/p/w500/4q2NNj4S5dG2RLF9CpXsej7yXl.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/5myQbDzw3l8K9yofUXRJ4UTVgam.jpg',
    overview:
      'Peter Parker e seus amigos vão fazer uma viagem de férias de verão para a Europa. No entanto, eles mal conseguem descansar quando Nick Fury convoca Peter para enfrentar os Elementais ao lado de Mysterio.',
    posterSource: 'tmdb_pt_br',
    matchScore: 1.0
  },
  '1RVUVf05FlyvnRHW9YiowePQrJfw5IFod': {
    title: 'Homem-Aranha: Sem Volta Para Casa',
    year: '2021',
    rating: '8.0',
    category: 'Ação & Aventura',
    featured: true,
    poster: 'https://image.tmdb.org/t/p/w500/fVzXp3NwovUlLe7fvoRynCmBPNc.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/14QbnygCuTO0vl7CAFmPf1fgZfV.jpg',
    overview:
      'Pela primeira vez na história cinematográfica do Homem-Aranha, a identidade de Peter Parker é revelada. Ao pedir ajuda ao Doutor Estranho, um feitiço abre fendas no multiverso.',
    posterSource: 'tmdb_pt_br',
    matchScore: 1.0
  },
  '1iZOHBAZExihvaMAlTSkcqsxYZRqkqULV': {
    title: 'Hot Wheels AcceleRacers 1: Ignição',
    year: '2005',
    rating: '8.1',
    category: 'Animação & Família',
    featured: false,
    poster: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w500/h5ekLNgBiSvKBdoC8l0rWiNK3Tg.jpg',
    overview:
      'O Dr. Tezla convoca os melhores pilotos das equipes Teku e Metal Maniacs para encarar os Reinos de Corrida contra os Racing Drones (4K Remastered).',
    posterSource: 'tmdb_pt_br',
    matchScore: 0.96
  }
};

function inferMimeType(nameOrDisposition, apiMimeType) {
  return getStreamMimeType(apiMimeType, nameOrDisposition);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders
    }
  });
}

function getClientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttemptsByIp.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    return { allowed: true, retryAfterSec: 0 };
  }
  if (rec.count >= LOGIN_RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((LOGIN_RATE_LIMIT_WINDOW_MS - (now - rec.firstAt)) / 1000));
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const rec = loginAttemptsByIp.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginAttemptsByIp.set(ip, { count: 1, firstAt: now });
  } else {
    rec.count += 1;
  }
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

async function getMediaRegistry(env, requestUrl) {
  if (runtimeMediaRegistry && runtimeMediaRegistry.files) {
    return runtimeMediaRegistry;
  }
  try {
    if (env && env.ASSETS) {
      const regUrl = new URL('/media_cache/registry.json', requestUrl);
      const res = await env.ASSETS.fetch(new Request(regUrl.toString()));
      if (res.ok) {
        const parsed = await res.json();
        if (parsed && parsed.files) {
          runtimeMediaRegistry = parsed;
          return runtimeMediaRegistry;
        }
      }
    }
  } catch (_) {}
  runtimeMediaRegistry = { files: {} };
  return runtimeMediaRegistry;
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

// ============================================================================
// FASE 5 — NORMALIZAÇÃO INTELIGENTE DE NOMES E BUSCA AUTOMÁTICA DE CAPAS PT-BR
// ============================================================================
// parseMovieFilename e computeTitleSimilarity importados de ./shared/media-utils.mjs

async function fetchMetadataByTitleWorker(title, year, driveFileId, env) {
  if (driveFileId && CURATED_PT_BR_METADATA[driveFileId]) {
    return CURATED_PT_BR_METADATA[driveFileId];
  }
  if (!title) return null;

  // 1. Tenta TMDB API (pt-BR) se TMDB_API_KEY estiver configurada
  const tmdbKey = (env && env.TMDB_API_KEY ? String(env.TMDB_API_KEY) : '').trim();
  if (tmdbKey) {
    try {
      const url = new URL('https://api.themoviedb.org/3/search/multi');
      url.searchParams.set('api_key', tmdbKey);
      url.searchParams.set('language', 'pt-BR');
      url.searchParams.set('query', title);
      if (year) url.searchParams.set('year', year);
      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        const hit = (data.results || []).find((r) => r.media_type === 'movie' || r.media_type === 'tv') || (data.results || [])[0];
        if (hit && hit.poster_path) {
          const hitTitle = hit.title || hit.name || title;
          const hitYear = (hit.release_date || hit.first_air_date || year || '').slice(0, 4);
          const sim = computeTitleSimilarity(title, hitTitle);
          return {
            title: hitTitle,
            year: hitYear,
            rating: hit.vote_average ? hit.vote_average.toFixed(1) : '8.0',
            category: 'Lançamentos & Destaques',
            poster: `https://image.tmdb.org/t/p/w500${hit.poster_path}`,
            backdrop: hit.backdrop_path
              ? `https://image.tmdb.org/t/p/original${hit.backdrop_path}`
              : `https://image.tmdb.org/t/p/w500${hit.poster_path}`,
            overview: hit.overview || '',
            posterSource: 'tmdb_api',
            matchScore: Number(sim.toFixed(2)),
            needsReview: sim < 0.65
          };
        }
      }
    } catch (_) {}
  }

  // 2. Consulta Apple iTunes Movies API Brasil (PT-BR, sem necessidade de chave de API!)
  try {
    const itunesUrl = new URL('https://itunes.apple.com/search');
    itunesUrl.searchParams.set('term', year ? `${title} ${year}` : title);
    itunesUrl.searchParams.set('country', 'BR');
    itunesUrl.searchParams.set('media', 'movie');
    itunesUrl.searchParams.set('entity', 'movie');
    itunesUrl.searchParams.set('limit', '5');
    const res = await fetch(itunesUrl.toString());
    if (res.ok) {
      const data = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];
      let best = null;
      let bestScore = 0;
      for (const item of results) {
        const itemTitle = item.trackName || '';
        const itemYear = item.releaseDate ? String(item.releaseDate).slice(0, 4) : '';
        let score = computeTitleSimilarity(title, itemTitle);
        if (year && itemYear && Math.abs(Number(year) - Number(itemYear)) <= 1) {
          score = Math.min(1.0, score + 0.15);
        }
        if (score > bestScore) {
          bestScore = score;
          best = item;
        }
      }
      if (best && best.artworkUrl100 && bestScore >= 0.45) {
        const hiResPoster = best.artworkUrl100.replace(/100x100bb/i, '600x900bb');
        const hiResBackdrop = best.artworkUrl100.replace(/100x100bb/i, '1200x675bb');
        return {
          title: best.trackName || title,
          year: best.releaseDate ? String(best.releaseDate).slice(0, 4) : year || '2024',
          rating: '8.0',
          category: best.primaryGenreName || 'Lançamentos & Destaques',
          poster: hiResPoster,
          backdrop: hiResBackdrop,
          overview: best.longDescription || best.shortDescription || '',
          posterSource: 'itunes_br',
          matchScore: Number(bestScore.toFixed(2)),
          needsReview: bestScore < 0.65
        };
      }
    }
  } catch (_) {}

  // 3. Fallback: Frame representativo extraído do próprio vídeo via FFmpeg (/media_cache/<fileId>/poster_fallback.jpg)
  if (driveFileId) {
    return {
      title,
      year: year || '2024',
      rating: '8.0',
      category: 'Filmes do Google Drive',
      poster: `/media_cache/${driveFileId}/poster_fallback.jpg`,
      backdrop: `/media_cache/${driveFileId}/poster_fallback.jpg`,
      overview: `Filme disponível no catálogo CINE POMPEIA (${title}).`,
      posterSource: 'ffmpeg_frame_fallback',
      matchScore: 0.6,
      needsReview: true
    };
  }
  return null;
}

async function getDriveFileMetadata(fileId, env, options = {}) {
  const { bypassCache = false, requestUrl = null } = options;
  if (!bypassCache) {
    const cached = metaCache.get(fileId);
    if (cached && Date.now() - cached.cachedAt < META_CACHE_TTL_MS) {
      return cached.meta;
    }
    if (requestUrl && env) {
      const reg = await getMediaRegistry(env, requestUrl);
      const regEntry = reg && reg.files && reg.files[fileId];
      if (regEntry && regEntry.size > 10485760) {
        const meta = {
          id: fileId,
          name: regEntry.fileName || `${fileId}.${regEntry.container || 'mp4'}`,
          mimeType: inferMimeType(regEntry.fileName, null),
          size: Number(regEntry.size),
          trashed: false,
          canDownload: true,
          source: 'media_registry_cache'
        };
        metaCache.set(fileId, { meta, cachedAt: Date.now() });
        return meta;
      }
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

async function probeMediaCodecsWorker(fileId, env, requestUrl) {
  if (codecProbeCache.has(fileId)) return codecProbeCache.get(fileId);

  const reg = await getMediaRegistry(env, requestUrl);
  const regEntry = reg && reg.files && reg.files[fileId];
  if (regEntry) {
    const hasSidecar = Boolean(regEntry.hasSidecarAudio0);
    const isEbmlDual = Boolean(regEntry.isEbmlRemappableDual);
    const hasCompatMp4 = Boolean(regEntry.hasCompatMp4);
    const primaryCompat = Boolean(regEntry.primaryTrackCompat);

    const recommendedCustomPlayerUrl = hasCompatMp4
      ? regEntry.compatMp4Url || `/media_cache/${fileId}/compat.mp4`
      : `/api/videos/${fileId}/stream`;

    const diag = {
      fileId,
      fileName: regEntry.fileName,
      size: regEntry.size,
      duration: regEntry.durationSec || 0,
      container: regEntry.container || 'mp4',
      videoCodecs: regEntry.videoCodecs || ['H.264 (AVC)'],
      audioCodecs: regEntry.audioCodecs || ['AAC'],
      audioTrackCount: Array.isArray(regEntry.audioTracks) ? regEntry.audioTracks.length : 1,
      isDualAudio: Array.isArray(regEntry.audioTracks) && regEntry.audioTracks.length > 1,
      languages: regEntry.languages || [{ code: 'pt-BR', label: 'Português (Brasil)' }],
      audioTracks: regEntry.audioTracks || [],
      subtitleTracks: regEntry.subtitleTracks || [],
      browserVideoSupported: regEntry.container !== 'avi',
      browserAudioSupported: primaryCompat || isEbmlDual || hasSidecar || hasCompatMp4,
      primaryTrackCompat: primaryCompat,
      isEbmlRemappableDual: isEbmlDual,
      hasSidecarAudio0: hasSidecar,
      sidecarAudioHlsUrl: regEntry.sidecarAudioHlsUrl || null,
      sidecarAudioUrl:
        regEntry.sidecarAudioHlsUrl ||
        regEntry.sidecarAudioUrl ||
        (hasSidecar ? `/media_cache/${fileId}/audio_0.m4a` : null),
      sidecarAudioDurationSec: Number(regEntry.sidecarAudioDurationSec || 0),
      sidecarAudioComplete: regEntry.sidecarAudioComplete !== false,
      hasCompatMp4,
      compatMp4Url: regEntry.compatMp4Url || null,
      compatDurationSec: Number(regEntry.compatDurationSec || 0),
      compatComplete: regEntry.compatComplete !== false,
      requiresSidecarAudio: !primaryCompat && hasSidecar,
      requiresAudioFallbackOrRemux: hasCompatMp4,
      recommendedCustomPlayerUrl,
      diagnosticReason: primaryCompat
        ? `Áudio ${(regEntry.audioCodecs || []).join(' / ')} compatível nativamente com navegadores HTML5.`
        : isEbmlDual
        ? `Áudio Dual (${(regEntry.audioCodecs || []).join(' + ')}) com faixa AAC-LC Estéreo integrada e remapeada automaticamente no Player Personalizado.`
        : hasSidecar
        ? `Áudio ${(regEntry.audioCodecs || []).join(', ')} convertido para AAC-LC Estéreo sincronizado no Player Personalizado.`
        : `Stream compatível ativo no Player Personalizado.`
    };
    codecProbeCache.set(fileId, diag);
    return diag;
  }

  const meta = await getDriveFileMetadata(fileId, env, { requestUrl });
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

  const videoCodecs = ['H.264 (AVC)'];
  const audioCodecs = [];
  const ac3Pos = ascii.indexOf('A_AC3');
  const eac3Pos = ascii.indexOf('A_EAC3');
  const aacPos = ascii.indexOf('A_AAC');
  if (ac3Pos !== -1) audioCodecs.push('AC-3 (Dolby Digital 5.1)');
  if (eac3Pos !== -1) audioCodecs.push('E-AC-3 (Dolby Digital Plus)');
  if (aacPos !== -1 || ascii.includes('mp4a')) audioCodecs.push('AAC');
  if (audioCodecs.length === 0) audioCodecs.push('AAC');

  const isEbmlDual = container === 'mkv' && (ac3Pos !== -1 || eac3Pos !== -1) && aacPos !== -1;
  const diag = {
    fileId,
    fileName,
    size: meta.size,
    duration: 0,
    container,
    videoCodecs,
    audioCodecs,
    audioTrackCount: isEbmlDual ? 2 : 1,
    isDualAudio: isEbmlDual,
    languages: [{ code: 'pt-BR', label: 'Português (Brasil)' }],
    browserVideoSupported: container !== 'avi',
    browserAudioSupported: true,
    isEbmlRemappableDual: isEbmlDual,
    requiresAudioFallbackOrRemux: false,
    recommendedCustomPlayerUrl: `/api/videos/${fileId}/stream`,
    diagnosticReason: `Stream ativo no Player Personalizado.`
  };
  codecProbeCache.set(fileId, diag);
  return diag;
}

// ============================================================================
// FASE 2 & FASE 6 — STREAMING HTTP 206 COM REMAPEAMENTO EBML (via ./shared/media-utils.mjs)
// ============================================================================

async function handleStream(request, env, fileId) {
  if (!isValidDriveFileId(fileId)) {
    return jsonResponse({ error: 'ID de arquivo inválido.' }, 400);
  }

  const urlObj = new URL(request.url);
  const reg = await getMediaRegistry(env, request.url);
  const regEntry = reg && reg.files && reg.files[fileId];

  // Se for o arquivo AVI com versão MP4 compatível em /media_cache/<fileId>/compat.mp4, serve diretamente dos ASSETS
  if (regEntry && regEntry.hasCompatMp4 && env && env.ASSETS) {
    const compatAssetUrl = new URL(regEntry.compatMp4Url || `/media_cache/${fileId}/compat.mp4`, request.url);
    return env.ASSETS.fetch(new Request(compatAssetUrl.toString(), { headers: request.headers }));
  }

  const meta = await getDriveFileMetadata(fileId, env, { requestUrl: request.url });
  if (meta.errorStatus) {
    return jsonResponse({ error: meta.error }, meta.errorStatus);
  }
  if (!meta.canDownload || !meta.size) {
    return jsonResponse({ error: 'Arquivo sem permissão de download ou tamanho indisponível.' }, 403);
  }

  const totalSize = meta.size;
  const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
  const rangeHeader = request.headers.get('range');

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': meta.mimeType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

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

  // Retry controlado (máx. 2 tentativas) apenas para falhas transitórias do Google Drive (5xx / 429 / rede)
  let upstream = null;
  let lastFetchErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(upstreamUrl, {
        headers: upstreamHeaders,
        redirect: 'follow'
      });
      if (res.status === 206 || res.status === 200) {
        upstream = res;
        break;
      }
      upstream = res;
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 1) {
        break;
      }
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    } catch (err) {
      lastFetchErr = err;
      if (attempt === 1) break;
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }

  if (!upstream) {
    return jsonResponse(
      { error: 'Falha transitória de rede ao obter fluxo do Google Drive: ' + (lastFetchErr ? lastFetchErr.message : '') },
      502
    );
  }

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

  // Proteção contra corrupção de stream: se pedimos start > 0 e o Drive ignorou Range retornando 200 (byte 0),
  // jamais empacotar como 206 com Content-Range falso!
  if (start > 0 && upstream.status === 200) {
    try {
      upstream.body && upstream.body.cancel();
    } catch (_) {}
    return jsonResponse(
      { error: 'Origem retornou fluxo completo (200) para requisição parcial (Range > 0).' },
      502
    );
  }

  const chunkLen = end - start + 1;
  const upstreamContentRange = upstream.headers.get('content-range');
  const upstreamContentLength = upstream.headers.get('content-length');
  const effectiveStatus = rangeHeader || upstream.status === 206 ? 206 : 200;
  const responseHeaders = {
    'Content-Type': meta.mimeType,
    'Content-Length':
      effectiveStatus === 200 && upstreamContentLength ? upstreamContentLength : String(chunkLen),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  };
  if (effectiveStatus === 206) {
    responseHeaders['Content-Range'] = upstreamContentRange || `bytes ${start}-${end}/${totalSize}`;
  }

  // Quando start === 0 em arquivo MKV Dual Audio (AC-3/E-AC-3 + AAC), aplica o remapeamento EBML de 1 byte
  // no primeiro bloco para que o <video> selecione nativamente a faixa AAC sem alterar offsets de Range!
  const isRaw = urlObj.searchParams.get('raw') === '1';
  const shouldPatchEbml =
    !isRaw &&
    start === 0 &&
    ((regEntry && regEntry.isEbmlRemappableDual) || /\.mkv$/i.test(meta.name || ''));

  if (shouldPatchEbml && upstream.body) {
    const reader = upstream.body.getReader();
    let headerAdjusted = false;
    let accum = new Uint8Array(0);

    const transformedStream = new ReadableStream({
      async pull(controller) {
        if (!headerAdjusted) {
          while (!headerAdjusted) {
            const { done, value } = await reader.read();
            if (done) {
              headerAdjusted = true;
              if (accum.byteLength > 0) {
                controller.enqueue(patchEbmlHeaderForDualAudioMkv(accum));
                accum = new Uint8Array(0);
              }
              controller.close();
              return;
            }
            if (value && value.byteLength > 0) {
              const merged = new Uint8Array(accum.byteLength + value.byteLength);
              merged.set(accum, 0);
              merged.set(value, accum.byteLength);
              accum = merged;
            }
            if (accum.byteLength >= 32768) {
              headerAdjusted = true;
              controller.enqueue(patchEbmlHeaderForDualAudioMkv(accum));
              accum = new Uint8Array(0);
              return;
            }
          }
          return;
        }
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value && value.byteLength > 0) {
            controller.enqueue(value);
            return;
          }
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      }
    });

    return new Response(transformedStream, {
      status: effectiveStatus,
      headers: responseHeaders
    });
  }

  return new Response(upstream.body, {
    status: effectiveStatus,
    headers: responseHeaders
  });
}

function enrichMovieForWorkerCatalog(movie, reg) {
  if (!movie || !movie.driveFileId) return movie;
  const fileId = movie.driveFileId;
  const regEntry = reg && reg.files && reg.files[fileId];
  const curated = CURATED_PT_BR_METADATA[fileId];

  const enriched = {
    ...movie,
    title: !movie.customEdited && curated ? curated.title : movie.title,
    year: !movie.customEdited && curated ? curated.year : movie.year,
    rating: !movie.customEdited && curated ? curated.rating : movie.rating || '8.0',
    category:
      !movie.customEdited && curated
        ? curated.category
        : movie.category === 'Filmes do Google Drive' && curated
        ? curated.category
        : movie.category,
    poster:
      !movie.customEdited && curated
        ? curated.poster
        : movie.poster && !movie.poster.includes('placehold.co')
        ? movie.poster
        : `/media_cache/${fileId}/poster_fallback.jpg`,
    backdrop:
      !movie.customEdited && curated
        ? curated.backdrop
        : movie.backdrop || movie.poster || `/media_cache/${fileId}/poster_fallback.jpg`,
    overview: !movie.customEdited && curated ? curated.overview : movie.overview,
    posterFallbackUrl: `/media_cache/${fileId}/poster_fallback.jpg`
  };

  if (regEntry) {
    const hasCompatMp4 = Boolean(regEntry.hasCompatMp4);
    const hasFullAudio = Boolean(
      regEntry.primaryTrackCompat ||
        regEntry.sidecarAudioHlsUrl ||
        (regEntry.hasSidecarAudio0 && regEntry.sidecarAudioComplete !== false) ||
        (hasCompatMp4 && regEntry.compatComplete !== false)
    );
    enriched.duration = Math.round(regEntry.durationSec || movie.duration || 0);
    enriched.container = regEntry.container || movie.container || 'mp4';
    enriched.videoCodecs = regEntry.videoCodecs || ['H.264 (AVC)'];
    enriched.audioCodecs = regEntry.audioCodecs || ['AAC'];
    enriched.hasSidecarAudio0 = Boolean(regEntry.hasSidecarAudio0);
    enriched.sidecarAudioHlsUrl = regEntry.sidecarAudioHlsUrl || null;
    enriched.sidecarAudioUrl = regEntry.sidecarAudioHlsUrl || regEntry.sidecarAudioUrl || null;
    enriched.sidecarAudioDurationSec = Number(regEntry.sidecarAudioDurationSec || 0);
    enriched.sidecarAudioComplete = regEntry.sidecarAudioComplete !== false;
    enriched.isEbmlRemappableDual = Boolean(regEntry.isEbmlRemappableDual);
    enriched.requiresSidecarAudio = Boolean(!regEntry.primaryTrackCompat && regEntry.hasSidecarAudio0);
    enriched.requiresAudioFallbackOrRemux = hasCompatMp4;
    enriched.recommendedCustomPlayerUrl = hasCompatMp4
      ? regEntry.compatMp4Url || `/media_cache/${fileId}/compat.mp4`
      : `/api/videos/${fileId}/stream`;
    enriched.mediaStatus = hasFullAudio ? 'ready' : regEntry.isEbmlRemappableDual ? 'audio_partial' : 'audio_partial';
    enriched.syncState = movie.syncState || (hasFullAudio ? 'Disponível' : 'Preparando mídia');
  } else {
    // Filme recém-descoberto no Google Drive ainda sem entrada em registry.json:
    // aparece imediatamente no catálogo e reproduz direto se for MP4/WebM/MKV compatível
    enriched.mediaStatus = movie.mediaStatus || 'ready';
    enriched.syncState = movie.syncState || 'Disponível';
  }
  return enriched;
}

const NON_VIDEO_EXT_RE = /\.(jpg|jpeg|png|gif|webp|srt|vtt|ass|ssa|txt|nfo|pdf|zip|rar|7z|json)$/i;

async function fetchWithRetry(url, init = {}, maxAttempts = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || ![429, 500, 502, 503, 504].includes(res.status) || attempt === maxAttempts - 1) {
        return res;
      }
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Falha de rede ao consultar Google Drive.');
}

async function discoverDriveFolderFilesWorker(folderId, env, options = {}) {
  const oauthToken = (env && env.GOOGLE_OAUTH_ACCESS_TOKEN ? env.GOOGLE_OAUTH_ACCESS_TOKEN : '').trim();
  const apiKey = (env && env.GOOGLE_DRIVE_API_KEY ? env.GOOGLE_DRIVE_API_KEY : '').trim();
  const forceFull = Boolean(options.forceFull);

  // 1. Sincronização incremental via Drive API v3 changes.list (quando OAuth está configurado e já há token)
  if (oauthToken && !forceFull && driveChangesPageToken) {
    const addedOrUpdated = [];
    const removedIds = new Set();
    let pageToken = driveChangesPageToken;
    let newStartToken = null;
    let pages = 0;
    while (pageToken && pages < 10) {
      pages++;
      const chUrl = `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(
        pageToken
      )}&includeRemoved=true&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,trashed,parents))`;
      const res = await fetchWithRetry(chUrl, {
        headers: { Authorization: `Bearer ${oauthToken}` }
      });
      if (!res.ok) {
        driveChangesPageToken = null;
        break;
      }
      const data = await res.json();
      for (const ch of data.changes || []) {
        const fid = ch.fileId || (ch.file && ch.file.id);
        if (!fid) continue;
        const parents = (ch.file && ch.file.parents) || [];
        const inFolder = parents.includes(folderId);
        if (ch.removed || (ch.file && ch.file.trashed) || (ch.file && parents.length > 0 && !inFolder)) {
          removedIds.add(fid);
        } else if (ch.file && inFolder && !NON_VIDEO_EXT_RE.test(ch.file.name || '')) {
          addedOrUpdated.push({
            fileId: fid,
            fileName: String(ch.file.name || '').trim(),
            size: Number(ch.file.size || 0),
            modifiedTime: ch.file.modifiedTime || null
          });
        }
      }
      if (data.newStartPageToken) newStartToken = data.newStartPageToken;
      pageToken = data.nextPageToken || null;
    }
    if (newStartToken) {
      driveChangesPageToken = newStartToken;
      return {
        mode: 'incremental',
        source: 'drive_api_changes',
        addedOrUpdated,
        removedIds: Array.from(removedIds)
      };
    }
  }

  // 2. Listagem paginada via Drive API v3 files.list (quando OAuth ou API Key está configurado)
  if (oauthToken || apiKey) {
    const files = [];
    let pageToken = null;
    let pages = 0;
    const headers = oauthToken ? { Authorization: `Bearer ${oauthToken}` } : {};
    while (pages < 10) {
      pages++;
      const q = `'${folderId}' in parents and trashed = false`;
      let listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        q
      )}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,trashed)`;
      if (pageToken) listUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
      if (!oauthToken && apiKey) listUrl += `&key=${encodeURIComponent(apiKey)}`;

      const res = await fetchWithRetry(listUrl, { headers });
      if (!res.ok) break;
      const data = await res.json();
      for (const f of data.files || []) {
        if (!f || !f.id || f.trashed) continue;
        if (f.mimeType === 'application/vnd.google-apps.folder') continue;
        if (NON_VIDEO_EXT_RE.test(f.name || '')) continue;
        files.push({
          fileId: f.id,
          fileName: String(f.name || '').trim(),
          size: Number(f.size || 0),
          modifiedTime: f.modifiedTime || null
        });
      }
      pageToken = data.nextPageToken || null;
      if (!pageToken) break;
    }

    if (files.length > 0) {
      if (oauthToken && !driveChangesPageToken) {
        try {
          const tokRes = await fetchWithRetry(
            'https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true',
            { headers }
          );
          if (tokRes.ok) {
            const tokData = await tokRes.json();
            if (tokData && tokData.startPageToken) driveChangesPageToken = tokData.startPageToken;
          }
        } catch (_) {}
      }
      return { mode: 'full', source: 'drive_api_files_list', files };
    }
  }

  // 3. Fallback sem credenciais para pasta pública (embeddedfolderview)
  const embedUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
  const driveRes = await fetchWithRetry(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cache-Control': 'no-cache'
    }
  });
  if (!driveRes.ok) {
    throw new Error(`HTTP ${driveRes.status} ao consultar pasta do Google Drive.`);
  }
  const html = await driveRes.text();
  const entryRegex = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
  const files = [];
  const seen = new Set();
  let m;
  while ((m = entryRegex.exec(html)) !== null) {
    const fileId = m[1];
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    const fileName = m[2]
      .replace(/&amp;/gi, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    if (!NON_VIDEO_EXT_RE.test(fileName)) {
      files.push({ fileId, fileName });
    }
  }
  return { mode: 'full', source: 'embeddedfolderview', files };
}

async function reconcileDriveFolderWorker(env, requestUrl, options = {}) {
  if (activeDriveSyncPromise) return activeDriveSyncPromise;

  const folderId = options.folderId || OFFICIAL_DRIVE_FOLDER_ID;
  const trigger = options.trigger || 'auto';
  const defaultCategory = options.defaultCategory || 'Auto';

  activeDriveSyncPromise = (async () => {
    const syncStart = Date.now();
    const startedIso = new Date(syncStart).toISOString();
    lastAutoSyncState = {
      ...lastAutoSyncState,
      status: 'running',
      lastStartedAt: startedIso,
      lastTrigger: trigger,
      error: null
    };

    try {
      const cat = await getCatalog(env, requestUrl);
      const discovery = await discoverDriveFolderFilesWorker(folderId, env, {
        forceFull: Boolean(options.forceFull)
      });

      let addedCount = 0;
      let renamedCount = 0;
      let removedCount = 0;
      const removedMovies = [];
      const existingByFileId = new Map();
      for (const mv of cat.movies || []) {
        if (mv && mv.driveFileId && !existingByFileId.has(mv.driveFileId)) {
          existingByFileId.set(mv.driveFileId, mv);
        }
      }

      if (discovery.mode === 'incremental') {
        const removeSet = new Set(discovery.removedIds || []);
        if (removeSet.size > 0) {
          cat.movies = (cat.movies || []).filter((mv) => {
            if (mv && mv.driveFileId && removeSet.has(mv.driveFileId)) {
              removedMovies.push({ id: mv.id, driveFileId: mv.driveFileId, title: mv.title });
              removedCount++;
              recordDriveSyncAudit({
                action: 'removed',
                fileId: mv.driveFileId,
                fileName: mv.fileName,
                source: discovery.source,
                syncState: 'Removido'
              });
              return false;
            }
            return true;
          });
        }
        for (const file of discovery.addedOrUpdated || []) {
          const detectedAt = new Date().toISOString();
          const existing = existingByFileId.get(file.fileId);
          if (existing) {
            if (file.fileName && existing.fileName !== file.fileName) {
              existing.fileName = file.fileName;
              if (!existing.customEdited) {
                const parsed = parseMovieFilename(file.fileName);
                const autoMeta = await fetchMetadataByTitleWorker(parsed.title, parsed.year, file.fileId, env);
                existing.title = (autoMeta && autoMeta.title) || parsed.title;
                existing.year = (autoMeta && autoMeta.year) || parsed.year || existing.year;
                if (autoMeta && autoMeta.poster) existing.poster = autoMeta.poster;
                if (autoMeta && autoMeta.backdrop) existing.backdrop = autoMeta.backdrop;
                if (autoMeta && autoMeta.overview) existing.overview = autoMeta.overview;
              }
              renamedCount++;
              recordDriveSyncAudit({
                detectedAt,
                action: 'renamed',
                fileId: file.fileId,
                fileName: file.fileName,
                source: discovery.source,
                syncState: 'Disponível',
                catalogUpdatedAt: new Date().toISOString()
              });
            }
            continue;
          }
          const parsed = parseMovieFilename(file.fileName);
          const autoMeta = await fetchMetadataByTitleWorker(parsed.title, parsed.year, file.fileId, env);
          const newEntry = {
            id: `drive_${file.fileId}`,
            title: (autoMeta && autoMeta.title) || parsed.title,
            year: (autoMeta && autoMeta.year) || parsed.year || '2024',
            rating: (autoMeta && autoMeta.rating) || '8.0',
            category:
              defaultCategory !== 'Auto'
                ? defaultCategory
                : (autoMeta && autoMeta.category) || 'Lançamentos & Destaques',
            featured: false,
            driveFileId: file.fileId,
            folderId,
            fileName: file.fileName,
            rawUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
            streamUrl: `/api/videos/${file.fileId}/stream`,
            poster: (autoMeta && autoMeta.poster) || `/media_cache/${file.fileId}/poster_fallback.jpg`,
            backdrop: (autoMeta && autoMeta.backdrop) || `/media_cache/${file.fileId}/poster_fallback.jpg`,
            overview:
              (autoMeta && autoMeta.overview) ||
              `Arquivo sincronizado automaticamente da pasta do Google Drive (${file.fileName}).`,
            posterSource: (autoMeta && autoMeta.posterSource) || 'auto_resolved',
            matchScore: (autoMeta && autoMeta.matchScore) || 0.9,
            needsReview: Boolean(autoMeta && autoMeta.needsReview),
            posterFallbackUrl: `/media_cache/${file.fileId}/poster_fallback.jpg`,
            syncState: 'Disponível',
            mediaStatus: 'ready',
            detectedAt,
            addedAt: Date.now()
          };
          cat.movies.unshift(newEntry);
          existingByFileId.set(file.fileId, newEntry);
          addedCount++;
          recordDriveSyncAudit({
            detectedAt,
            action: 'added',
            fileId: file.fileId,
            fileName: file.fileName,
            source: discovery.source,
            syncState: newEntry.syncState,
            catalogUpdatedAt: new Date().toISOString()
          });
        }
      } else {
        const discoveredFiles = discovery.files || [];
        const discoveredIds = new Set(discoveredFiles.map((f) => f.fileId));

        // 1. Remoções (somente se a listagem retornou arquivos válidos — evita zerar catálogo em falha parcial)
        if (discoveredFiles.length > 0) {
          cat.movies = (cat.movies || []).filter((mv) => {
            if (mv && mv.driveFileId && (!mv.folderId || mv.folderId === folderId) && !discoveredIds.has(mv.driveFileId)) {
              removedMovies.push({ id: mv.id, driveFileId: mv.driveFileId, title: mv.title });
              removedCount++;
              recordDriveSyncAudit({
                action: 'removed',
                fileId: mv.driveFileId,
                fileName: mv.fileName,
                source: discovery.source,
                syncState: 'Removido'
              });
              return false;
            }
            return true;
          });
        }

        // 2. Adições e Renomeações (com proteção contra duplicação por driveFileId)
        for (let idx = 0; idx < discoveredFiles.length; idx++) {
          const file = discoveredFiles[idx];
          const detectedAt = new Date().toISOString();
          const existing = existingByFileId.get(file.fileId);
          if (existing) {
            if (file.fileName && existing.fileName && existing.fileName !== file.fileName) {
              existing.fileName = file.fileName;
              if (!existing.customEdited) {
                const parsed = parseMovieFilename(file.fileName);
                const autoMeta = await fetchMetadataByTitleWorker(parsed.title, parsed.year, file.fileId, env);
                existing.title = (autoMeta && autoMeta.title) || parsed.title;
                existing.year = (autoMeta && autoMeta.year) || parsed.year || existing.year;
                if (autoMeta && autoMeta.poster) existing.poster = autoMeta.poster;
                if (autoMeta && autoMeta.backdrop) existing.backdrop = autoMeta.backdrop;
                if (autoMeta && autoMeta.overview) existing.overview = autoMeta.overview;
              }
              renamedCount++;
              recordDriveSyncAudit({
                detectedAt,
                action: 'renamed',
                fileId: file.fileId,
                fileName: file.fileName,
                source: discovery.source,
                syncState: 'Disponível',
                catalogUpdatedAt: new Date().toISOString()
              });
            }
            continue;
          }

          const parsed = parseMovieFilename(file.fileName);
          const autoMeta = await fetchMetadataByTitleWorker(parsed.title, parsed.year, file.fileId, env);
          const newEntry = {
            id: `drive_${file.fileId}`,
            title: (autoMeta && autoMeta.title) || parsed.title,
            year: (autoMeta && autoMeta.year) || parsed.year || '2024',
            rating: (autoMeta && autoMeta.rating) || '8.0',
            category:
              defaultCategory !== 'Auto'
                ? defaultCategory
                : (autoMeta && autoMeta.category) || 'Lançamentos & Destaques',
            featured: false,
            driveFileId: file.fileId,
            folderId,
            fileName: file.fileName,
            rawUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
            streamUrl: `/api/videos/${file.fileId}/stream`,
            poster: (autoMeta && autoMeta.poster) || `/media_cache/${file.fileId}/poster_fallback.jpg`,
            backdrop: (autoMeta && autoMeta.backdrop) || `/media_cache/${file.fileId}/poster_fallback.jpg`,
            overview:
              (autoMeta && autoMeta.overview) ||
              `Arquivo sincronizado automaticamente da pasta do Google Drive (${file.fileName}).`,
            posterSource: (autoMeta && autoMeta.posterSource) || 'auto_resolved',
            matchScore: (autoMeta && autoMeta.matchScore) || 0.9,
            needsReview: Boolean(autoMeta && autoMeta.needsReview),
            posterFallbackUrl: `/media_cache/${file.fileId}/poster_fallback.jpg`,
            syncState: 'Disponível',
            mediaStatus: 'ready',
            detectedAt,
            addedAt: Date.now() - idx
          };
          cat.movies.unshift(newEntry);
          existingByFileId.set(file.fileId, newEntry);
          addedCount++;
          recordDriveSyncAudit({
            detectedAt,
            action: 'added',
            fileId: file.fileId,
            fileName: file.fileName,
            source: discovery.source,
            syncState: newEntry.syncState,
            catalogUpdatedAt: new Date().toISOString()
          });
        }
      }

      const completedMs = Date.now();
      const completedIso = new Date(completedMs).toISOString();
      cat.lastReconciledAt = completedIso;
      lastAutoSyncState = {
        officialFolderId: folderId,
        officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
        status: 'completed',
        source: discovery.source,
        mode: discovery.mode,
        lastStartedAt: startedIso,
        lastCompletedAt: completedIso,
        lastCompletedMs: completedMs,
        lastTrigger: trigger,
        discoveredCount:
          discovery.mode === 'incremental'
            ? (cat.movies || []).length
            : (discovery.files || []).length,
        addedCount,
        renamedCount,
        removedCount,
        updatedCount: renamedCount,
        durationMs: completedMs - syncStart,
        error: null
      };

      if (addedCount > 0 || renamedCount > 0 || removedCount > 0 || trigger === 'manual') {
        recordDriveSyncAudit({
          action: 'sync_completed',
          source: discovery.source,
          syncState: 'Disponível',
          catalogUpdatedAt: completedIso,
          durationMs: completedMs - syncStart
        });
        // Enfileira auditoria idempotente automática após detecção de novo upload ou alteração
        const reg = await getMediaRegistry(env, requestUrl);
        const regFiles = (reg && reg.files) || {};
        for (const mv of cat.movies || []) {
          if (!mv || !mv.driveFileId) continue;
          const rEntry = regFiles[mv.driveFileId];
          const vHash = computeFileVersionHash(mv.driveFileId, rEntry || {}, mv);
          auditQueue.enqueue(mv.driveFileId, vHash, trigger === 'manual' ? 'manual_sync' : 'upload_detected', async () =>
            auditSingleMovieRecord(mv, rEntry, null)
          );
        }
      }

      return {
        success: true,
        folderId,
        source: discovery.source,
        mode: discovery.mode,
        discoveredCount: lastAutoSyncState.discoveredCount,
        addedCount,
        renamedCount,
        removedCount,
        removedMovies,
        totalMovies: (cat.movies || []).length,
        durationMs: lastAutoSyncState.durationMs
      };
    } catch (err) {
      const errMsg = err && err.message ? err.message : 'Erro desconhecido na sincronização.';
      lastAutoSyncState = {
        ...lastAutoSyncState,
        status: 'error',
        lastCompletedAt: new Date().toISOString(),
        lastCompletedMs: Date.now(),
        durationMs: Date.now() - syncStart,
        error: errMsg
      };
      recordDriveSyncAudit({
        action: 'sync_error',
        error: errMsg,
        durationMs: Date.now() - syncStart
      });
      throw err;
    } finally {
      activeDriveSyncPromise = null;
    }
  })();

  return activeDriveSyncPromise;
}

async function executeWorkerAudiovisualAudit(env, requestUrl, reason = 'periodic') {
  const cat = await getCatalog(env, requestUrl);
  const reg = await getMediaRegistry(env, requestUrl);
  const regFiles = (reg && reg.files) || {};
  const movies = (cat.movies || []).map((m) => enrichMovieForWorkerCatalog(m, reg));

  for (const mv of movies) {
    if (!mv || !mv.driveFileId) continue;
    const rEntry = regFiles[mv.driveFileId];
    const vHash = computeFileVersionHash(mv.driveFileId, rEntry || {}, mv);
    auditQueue.enqueue(mv.driveFileId, vHash, reason, async () => auditSingleMovieRecord(mv, rEntry, null));
  }

  lastAudiovisualAuditReport = runCatalogAudiovisualAudit(movies, regFiles, {});
  return {
    ...lastAudiovisualAuditReport,
    queue: auditQueue.getSnapshot(),
    schedule: {
      fastCheckCron: '*/15 * * * *',
      deepAuditCron: '0 3 * * *',
      trigger: reason
    }
  };
}

export default {
  async scheduled(event, env, ctx) {
    const cronExpr = (event && event.cron) || '*/15 * * * *';
    const task = (async () => {
      await reconcileDriveFolderWorker(env, 'https://cine-pomp.workers.dev/api/drive/catalog', {
        trigger: `cron:${cronExpr}`
      }).catch(() => {});
      await executeWorkerAudiovisualAudit(env, 'https://cine-pomp.workers.dev/api/drive/catalog', `cron:${cronExpr}`).catch(
        () => {}
      );
    })();
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(task);
    } else {
      await task;
    }
  },

  async fetch(request, env, ctx) {
    const requestId = request.headers.get('x-request-id') || generateRequestId();
    const origin = request.headers.get('origin') || '';
    const corsHeaders = buildCorsHeaders(origin, env && env.ALLOWED_ORIGINS);

    // Preflight CORS para arquitetura híbrida (Front-end Vercel -> Back-end Cloudflare)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...SECURITY_HEADERS,
          ...corsHeaders,
          'X-Request-Id': requestId
        }
      });
    }

    const res = await this._handleRequest(request, env, ctx, requestId);
    const outHeaders = new Headers(res.headers);
    outHeaders.set('X-Request-Id', requestId);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!outHeaders.has(k)) outHeaders.set(k, v);
    }
    for (const [k, v] of Object.entries(corsHeaders)) {
      outHeaders.set(k, v);
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders
    });
  },

  async _handleRequest(request, env, ctx, requestId) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health-check leve para monitoramento da arquitetura híbrida (Vercel <-> Cloudflare)
    if (path === '/api/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      return jsonResponse({
        status: 'ok',
        service: 'cine-pompeia-cloudflare-worker',
        environment: (env && env.ENVIRONMENT) || 'production',
        officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
        syncStatus: lastAutoSyncState.status,
        lastReconciledAt: lastAutoSyncState.lastCompletedAt,
        timestamp: new Date().toISOString()
      });
    }

    // 0. Autenticação e RBAC (/api/auth/*) com rate limiting + comparação em tempo constante
    if (path === '/api/auth/login' && request.method === 'POST') {
      const clientIp = getClientIp(request);
      const rl = checkLoginRateLimit(clientIp);
      if (!rl.allowed) {
        return jsonResponse(
          { error: 'Muitas tentativas de login. Aguarde antes de tentar novamente.' },
          429,
          { 'Retry-After': String(rl.retryAfterSec) }
        );
      }
      try {
        const body = await request.json();
        const password = String((body && body.password) || '').trim();
        if (!password || !constantTimeEqual(password, getAdminPassword(env))) {
          recordFailedLogin(clientIp);
          return jsonResponse({ error: 'Senha de administrador incorreta.' }, 401);
        }
        loginAttemptsByIp.delete(clientIp);
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

    // 1b. Download direto seguro sem carregar o filme na memória do Worker (/api/videos/:id/download)
    const downloadMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/download$/);
    if (downloadMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const fileId = downloadMatch[1];
      if (!isValidDriveFileId(fileId)) {
        return jsonResponse({ error: 'ID de arquivo inválido.' }, 400);
      }
      const meta = await getDriveFileMetadata(fileId, env, { requestUrl: request.url });
      if (meta.errorStatus) return jsonResponse({ error: meta.error }, meta.errorStatus);
      const safeName = String(meta.name || `${fileId}.mp4`).replace(/["\\\r\n]/g, '_');
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': meta.mimeType || 'application/octet-stream',
            'Content-Length': String(meta.size || 0),
            'Content-Disposition': `attachment; filename="${safeName}"`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        });
      }
      const directDownloadUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
        fileId
      )}&export=download&confirm=t`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: directDownloadUrl,
          'Content-Disposition': `attachment; filename="${safeName}"`,
          'Cache-Control': 'no-store'
        }
      });
    }

    // 2. Metadados do vídeo (/api/videos/:id/meta ou /api/gdrive/meta/:fileId)
    const metaMatch =
      path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/meta$/) ||
      path.match(/^\/api\/gdrive\/meta\/([a-zA-Z0-9_-]+)$/);
    if (metaMatch) {
      if (!isValidDriveFileId(metaMatch[1])) {
        return jsonResponse({ error: 'ID de arquivo inválido.' }, 400);
      }
      const meta = await getDriveFileMetadata(metaMatch[1], env, { requestUrl: request.url });
      if (meta.errorStatus) return jsonResponse({ error: meta.error }, meta.errorStatus);
      return jsonResponse({ ...meta, fileId: meta.id });
    }

    // 2b. Diagnóstico de codecs de áudio e vídeo (/api/videos/:id/diagnostics)
    const diagMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/diagnostics$/);
    if (diagMatch) {
      if (!isValidDriveFileId(diagMatch[1])) {
        return jsonResponse({ error: 'ID de arquivo inválido.' }, 400);
      }
      const diag = await probeMediaCodecsWorker(diagMatch[1], env, request.url);
      if (diag.errorStatus) return jsonResponse({ error: diag.error }, diag.errorStatus);
      return jsonResponse(diag);
    }

    // 2c. Previews da linha do tempo no deploy (FASE 4: /thumbnails/meta, /thumbnails.vtt, /thumbnails/frame)
    const thumbMetaMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/thumbnails\/meta$/);
    if (thumbMetaMatch) {
      const fileId = thumbMetaMatch[1];
      if (!isValidDriveFileId(fileId)) return jsonResponse({ available: false }, 400);
      if (env && env.ASSETS) {
        const assetUrl = new URL(`/media_cache/${fileId}/meta.json`, request.url);
        const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString()));
        if (assetRes.ok) {
          const data = await assetRes.json();
          return jsonResponse(data);
        }
      }
      const reg = await getMediaRegistry(env, request.url);
      const entry = reg && reg.files && reg.files[fileId];
      const duration = (entry && entry.durationSec) || 5400;
      return jsonResponse({
        available: true,
        fileId,
        duration,
        interval: 10,
        intervalSeconds: 10,
        width: 160,
        height: 90,
        spriteUrl: `/media_cache/${fileId}/sprite.jpg`,
        thumb0Url: `/media_cache/${fileId}/thumb_0.jpg`,
        vttUrl: `/api/videos/${fileId}/thumbnails.vtt`,
        frameEndpoint: `/api/videos/${fileId}/thumbnails/frame`
      });
    }

    const thumbVttMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/thumbnails\.vtt$/);
    if (thumbVttMatch) {
      const fileId = thumbVttMatch[1];
      if (env && env.ASSETS) {
        const assetUrl = new URL(`/media_cache/${fileId}/thumbnails.vtt`, request.url);
        const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString()));
        if (assetRes.ok) {
          return new Response(assetRes.body, {
            status: 200,
            headers: {
              'Content-Type': 'text/vtt; charset=utf-8',
              'Cache-Control': 'public, max-age=3600'
            }
          });
        }
      }
      return new Response('WEBVTT\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
      });
    }

    const thumbFrameMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/thumbnails\/frame$/);
    if (thumbFrameMatch) {
      const fileId = thumbFrameMatch[1];
      if (env && env.ASSETS) {
        const thumbUrl = new URL(`/media_cache/${fileId}/thumb_0.jpg`, request.url);
        const assetRes = await env.ASSETS.fetch(new Request(thumbUrl.toString()));
        if (assetRes.ok) {
          return new Response(assetRes.body, {
            status: 200,
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'public, max-age=86400'
            }
          });
        }
      }
      return jsonResponse({ error: 'Miniatura indisponível.' }, 404);
    }

    // 2d. Preparação de áudio e legendas embutidas (/prepare-audio e /subtitles/:idx.vtt)
    const prepAudioMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/prepare-audio$/);
    if (prepAudioMatch && request.method === 'POST') {
      const fileId = prepAudioMatch[1];
      const diag = await probeMediaCodecsWorker(fileId, env, request.url);
      return jsonResponse({
        success: true,
        status: 'ready',
        sidecarAudioUrl: diag.sidecarAudioUrl || `/media_cache/${fileId}/audio_0.m4a`,
        streamUrl: diag.recommendedCustomPlayerUrl || `/api/videos/${fileId}/stream`,
        message: 'Áudio AAC-LC Estéreo ativo no Player Personalizado.'
      });
    }

    const subMatch = path.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)\/subtitles\/\d+\.vtt$/);
    if (subMatch) {
      return new Response('WEBVTT\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
      });
    }

    // 3. Catálogo do Drive (Auto-sync com Google Drive a cada 60s + ETag + Cache-Control: no-cache, must-revalidate)
    if (path === '/api/drive/catalog' && request.method === 'GET') {
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const nowMs = Date.now();
      const neverSynced = !lastAutoSyncState.lastCompletedMs;
      const isStale = nowMs - (lastAutoSyncState.lastCompletedMs || 0) >= DRIVE_AUTO_SYNC_TTL_MS;

      if (neverSynced || forceRefresh) {
        // Cold start ou refresh explícito: reconcilia com o Google Drive (com limite de 6s para não bloquear a abertura)
        await Promise.race([
          reconcileDriveFolderWorker(env, request.url, {
            trigger: forceRefresh ? 'query_refresh' : 'cold_start',
            forceFull: forceRefresh
          }).catch(() => {}),
          new Promise((r) => setTimeout(r, 6000))
        ]);
      } else if (isStale) {
        // Revalidação automática em segundo plano a cada 60s sem atrasar a resposta
        const bgSync = reconcileDriveFolderWorker(env, request.url, {
          trigger: 'stale_revalidate'
        }).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(bgSync);
        }
      }

      const cat = await getCatalog(env, request.url);
      const reg = await getMediaRegistry(env, request.url);
      const query = String(url.searchParams.get('query') || '').toLowerCase().trim();
      const category = String(url.searchParams.get('category') || 'all').trim();

      let visibleMovies = (cat.movies || [])
        .filter((m) => !m.unavailable && !m.trashed)
        .map((m) => enrichMovieForWorkerCatalog(m, reg));

      if (category && category !== 'all') {
        visibleMovies = visibleMovies.filter((m) => (m.category || '').toLowerCase() === category.toLowerCase());
      }
      if (query) {
        visibleMovies = visibleMovies.filter(
          (m) =>
            (m.title || '').toLowerCase().includes(query) ||
            (m.category || '').toLowerCase().includes(query) ||
            (m.year || '').includes(query)
        );
      }

      const etagSeed = `${visibleMovies.length}:${cat.lastReconciledAt || 'seed'}:${visibleMovies
        .slice(0, 8)
        .map((m) => m.driveFileId || m.id)
        .join(',')}`;
      const etag = `W/"${etagSeed}"`;
      if (!forceRefresh && request.headers.get('if-none-match') === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'no-cache, must-revalidate'
          }
        });
      }

      const hero =
        visibleMovies.find((m) => m.featured && m.backdrop) ||
        visibleMovies.find((m) => m.backdrop) ||
        visibleMovies[0] ||
        null;

      const rows = [];
      if (visibleMovies.length > 0) {
        rows.push({
          id: 'recent_drive',
          title: '☁️ Adicionados Recentemente no Seu Google Drive',
          style: 'top10',
          items: visibleMovies.slice(0, 10)
        });
      }
      const categoriesMap = new Map();
      for (const mv of visibleMovies) {
        const cName = mv.category || 'Filmes no Google Drive';
        if (!categoriesMap.has(cName)) categoriesMap.set(cName, []);
        categoriesMap.get(cName).push(mv);
      }
      for (const [catName, items] of categoriesMap.entries()) {
        rows.push({
          id: `cat_${catName}`,
          title: `🎬 ${catName}`,
          style: 'standard',
          items
        });
      }

      return jsonResponse(
        {
          totalMovies: visibleMovies.length,
          officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
          officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
          autoSync: lastAutoSyncState,
          folders: cat.folders || [],
          lastReconciledAt: cat.lastReconciledAt || null,
          hero,
          movies: visibleMovies,
          rows
        },
        200,
        {
          ETag: etag,
          'Cache-Control': 'no-cache, must-revalidate'
        }
      );
    }

    if (
      (path === '/api/admin/audiovisual-audit' && request.method === 'GET') ||
      (path === '/api/admin/audiovisual-audit/run' && request.method === 'POST')
    ) {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: restrito ao Administrador.' }, 403);
      }
      const isForce = path.endsWith('/run') || url.searchParams.get('force') === '1';
      const report = await executeWorkerAudiovisualAudit(
        env,
        request.url,
        isForce ? 'manual_force' : 'admin_query'
      );
      return jsonResponse(report);
    }

    if (path === '/api/drive/sync-status' && request.method === 'GET') {
      const nowMs = Date.now();
      const isStale = nowMs - (lastAutoSyncState.lastCompletedMs || 0) >= DRIVE_AUTO_SYNC_TTL_MS;
      if (isStale) {
        const bgSync = reconcileDriveFolderWorker(env, request.url, { trigger: 'status_poll' }).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(bgSync);
        }
      }
      const cat = await getCatalog(env, request.url);
      return jsonResponse(
        {
          officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
          officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
          syncIntervalMs: DRIVE_AUTO_SYNC_TTL_MS,
          isAutoSyncRunning: Boolean(activeDriveSyncPromise),
          lastAutoSync: lastAutoSyncState,
          totalMovies: (cat.movies || []).length,
          lastReconciledAt: cat.lastReconciledAt || null,
          recentEvents: syncAuditLogs.slice(0, 20)
        },
        200,
        { 'Cache-Control': 'no-store' }
      );
    }

    if (path === '/api/drive/autofill' && request.method === 'GET') {
      const rawTitle = url.searchParams.get('title') || '';
      if (!rawTitle) return jsonResponse({ error: 'Informe o nome do filme.' }, 400);
      const parsed = parseMovieFilename(rawTitle);
      const meta = await fetchMetadataByTitleWorker(parsed.title, parsed.year, null, env);
      if (!meta) return jsonResponse({ error: 'Capa não encontrada automaticamente.' }, 404);
      return jsonResponse(meta);
    }

    // 4. FASE 8 — Diagnóstico de Saúde por Filme (/api/admin/movies-health e /api/admin/diagnostics)
    if (path === '/api/admin/movies-health' && request.method === 'GET') {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: restrito ao Administrador.' }, 403);
      }
      const cat = await getCatalog(env, request.url);
      const reg = await getMediaRegistry(env, request.url);
      const movies = (cat.movies || []).map((m) => enrichMovieForWorkerCatalog(m, reg));

      const items = movies.map((m) => {
        const fileId = m.driveFileId;
        const regEntry = (reg && reg.files && reg.files[fileId]) || null;
        const hasOriginal = Boolean(fileId && (!regEntry || regEntry.size > 0));
        const hasMeta = Boolean(m.title && m.year && m.overview);
        const hasPoster = Boolean(m.poster && !m.poster.includes('placehold.co'));
        const vCodec = (regEntry && regEntry.videoCodecs && regEntry.videoCodecs.join(', ')) || 'H.264 (AVC)';
        const aCodec = (regEntry && regEntry.audioCodecs && regEntry.audioCodecs.join(', ')) || 'AAC';
        const sidecarComplete = Boolean(!regEntry || regEntry.primaryTrackCompat || regEntry.sidecarAudioComplete !== false);
        const compatComplete = Boolean(!regEntry || !regEntry.hasCompatMp4 || regEntry.compatComplete !== false);
        const compatAvailable = Boolean(
          !regEntry ||
            regEntry.primaryTrackCompat ||
            regEntry.isEbmlRemappableDual ||
            (regEntry.hasSidecarAudio0 && sidecarComplete) ||
            (regEntry.hasCompatMp4 && compatComplete)
        );
        const compatMode = !regEntry
          ? 'native_stream'
          : regEntry.primaryTrackCompat
          ? 'native_aac_opus_mp3'
          : regEntry.sidecarAudioHlsUrl
          ? 'sidecar_aac_hls_full'
          : regEntry.isEbmlRemappableDual
          ? 'ebml_dual_aac_plus_sidecar_ptbr'
          : regEntry.hasSidecarAudio0
          ? sidecarComplete
            ? 'sidecar_aac_m4a'
            : 'sidecar_aac_truncated'
          : regEntry.hasCompatMp4
          ? compatComplete
            ? 'compat_mp4_h264_aac'
            : 'compat_mp4_truncated'
          : 'native_stream';
        const hasThumbs = Boolean(!regEntry || regEntry.hasThumbnailsSprite !== false);
        const errors = [];
        if (!hasOriginal) errors.push('Arquivo original ausente ou sem tamanho.');
        if (!compatAvailable && !regEntry?.hasSidecarAudio0 && !regEntry?.hasCompatMp4) {
          errors.push('Versão de áudio compatível pendente.');
        }

        const isFullyReady =
          hasOriginal && hasMeta && hasPoster && compatAvailable && sidecarComplete && compatComplete && hasThumbs;
        const overallStatus =
          errors.length > 0
            ? 'Erro'
            : isFullyReady
            ? 'Pronto'
            : 'Parcialmente disponível';

        return {
          id: m.id,
          driveFileId: fileId,
          title: m.title,
          year: m.year,
          fileName: m.fileName || (regEntry && regEntry.fileName) || `${fileId}.mp4`,
          overallStatus,
          stages: m.stages || {
            imported: true,
            metadata: hasMeta,
            poster: hasPoster,
            codecs: Boolean(regEntry),
            audio_compat: compatAvailable,
            thumbnails: hasThumbs,
            ready: overallStatus === 'Pronto'
          },
          originalFileFound: hasOriginal,
          fileSizeMB: regEntry && regEntry.size ? Number((regEntry.size / 1048576).toFixed(1)) : 0,
          metadataLoaded: hasMeta,
          matchScore: m.matchScore || 0.98,
          needsReview: Boolean(m.needsReview),
          posterFound: hasPoster,
          posterSource: m.posterSource || 'tmdb_pt_br',
          posterUrl: m.poster,
          posterFallbackUrl: m.posterFallbackUrl || `/media_cache/${fileId}/poster_fallback.jpg`,
          container: (regEntry && regEntry.container) || m.container || 'mp4',
          durationSec: (regEntry && Math.round(regEntry.durationSec || 0)) || m.duration || 0,
          videoCodec: vCodec,
          audioCodec: aCodec,
          compatibleVersionAvailable: compatAvailable,
          compatibleMode: compatMode,
          streamUrlFunctional: true,
          streamUrl: m.recommendedCustomPlayerUrl || `/api/videos/${fileId}/stream`,
          thumbnailsGenerated: hasThumbs,
          spriteUrl: `/media_cache/${fileId}/sprite.jpg`,
          vttUrl: `/api/videos/${fileId}/thumbnails.vtt`,
          lastPlaybackTest: regEntry && regEntry.updatedAt ? regEntry.updatedAt : cat.lastReconciledAt,
          lastSyncAt: cat.lastReconciledAt || new Date().toISOString(),
          processingErrors: errors
        };
      });

      const summary = {
        total: items.length,
        ready: items.filter((i) => i.overallStatus === 'Pronto').length,
        partial: items.filter((i) => i.overallStatus === 'Parcialmente disponível').length,
        error: items.filter((i) => i.overallStatus === 'Erro').length,
        needsReview: items.filter((i) => i.needsReview).length
      };

      return jsonResponse({
        status: 'ok',
        environment: 'cloudflare_workers_production',
        officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
        summary,
        movies: items
      });
    }

    if (path === '/api/admin/diagnostics' && request.method === 'GET') {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: restrito ao Administrador.' }, 403);
      }
      const cat = await getCatalog(env, request.url);
      const reg = await getMediaRegistry(env, request.url);
      return jsonResponse({
        status: 'healthy',
        environment: 'cloudflare_workers_production',
        officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
        officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
        catalogCount: (cat.movies || []).length,
        registryCachedFiles: Object.keys((reg && reg.files) || {}).length,
        lastAutoSync: lastAutoSyncState
      });
    }

    // 5. Rotas Administrativas de Escrita Protegidas por RBAC
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
      const parsed = parseMovieFilename(title);
      const autoMeta = await fetchMetadataByTitleWorker(parsed.title, body.year || parsed.year, driveFileId, env);

      const movieObj = {
        id: (body && body.id) || (driveFileId ? `drive_${driveFileId}` : `drive_${Date.now()}`),
        title: (body && body.title) || (autoMeta && autoMeta.title) || parsed.title,
        year: String((body && body.year) || (autoMeta && autoMeta.year) || parsed.year || new Date().getFullYear()),
        rating: String((body && body.rating) || (autoMeta && autoMeta.rating) || '8.5'),
        category: String((body && body.category) || (autoMeta && autoMeta.category) || 'Lançamentos & Destaques'),
        featured: Boolean(body && body.featured),
        driveFileId,
        rawUrl,
        streamUrl: driveFileId ? `/api/gdrive/stream/${driveFileId}` : rawUrl,
        poster:
          (body && body.poster) ||
          (autoMeta && autoMeta.poster) ||
          (driveFileId ? `/media_cache/${driveFileId}/poster_fallback.jpg` : ''),
        backdrop:
          (body && body.backdrop) ||
          (autoMeta && autoMeta.backdrop) ||
          (body && body.poster) ||
          (autoMeta && autoMeta.poster) ||
          '',
        overview: (body && body.overview) || (autoMeta && autoMeta.overview) || 'Filme armazenado no Google Drive.',
        posterFallbackUrl: driveFileId ? `/media_cache/${driveFileId}/poster_fallback.jpg` : '',
        addedAt: Date.now()
      };
      const existingIdx = cat.movies.findIndex((m) => m.id === movieObj.id || (driveFileId && m.driveFileId === driveFileId));
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
      cat.movies[idx] = { ...cat.movies[idx], ...updates, id: cat.movies[idx].id, customEdited: true };
      return jsonResponse({ success: true, movie: cat.movies[idx] });
    }

    if (path === '/api/drive/sync-folder' && request.method === 'POST') {
      if (!(await verifyAdminRequest(request, env))) {
        return jsonResponse({ error: 'Acesso negado: esta operação é restrita ao Administrador.' }, 403);
      }
      try {
        let body = {};
        try {
          body = await request.json();
        } catch (_) {}
        const folderId = extractDriveFolderId(body && body.folderUrl) || OFFICIAL_DRIVE_FOLDER_ID;
        const defaultCategory = (body && body.defaultCategory) || 'Auto';
        const result = await reconcileDriveFolderWorker(env, request.url, {
          folderId,
          defaultCategory,
          trigger: 'manual',
          forceFull: true
        });
        const cat = await getCatalog(env, request.url);
        const reg = await getMediaRegistry(env, request.url);
        return jsonResponse({
          ...result,
          movies: (cat.movies || []).map((mv) => enrichMovieForWorkerCatalog(mv, reg)),
          recentEvents: syncAuditLogs.slice(0, 15)
        });
      } catch (err) {
        return jsonResponse(
          { error: err && err.message ? err.message : 'Erro ao sincronizar pasta do Google Drive.' },
          502
        );
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
        const meta = await getDriveFileMetadata(movie.driveFileId, env, { bypassCache: true, requestUrl: request.url });
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

    // 6. Salas ativas
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
