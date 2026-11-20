require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { Server } = require('socket.io');
const {
  SECURITY_HEADERS,
  generateRequestId,
  patchEbmlHeaderForUnsupportedAudio
} = require('./src/shared/media-utils.mjs');

let FFMPEG_BIN = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';
try {
  const staticFfmpeg = require('ffmpeg-static');
  if (staticFfmpeg && fs.existsSync(staticFfmpeg)) FFMPEG_BIN = staticFfmpeg;
} catch (_) {}
try {
  const staticFfprobe = require('ffprobe-static');
  if (staticFfprobe && staticFfprobe.path && fs.existsSync(staticFfprobe.path)) {
    FFPROBE_BIN = staticFfprobe.path;
  }
} catch (_) {}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Observabilidade (X-Request-Id), Cabeçalhos de Segurança e Compressão Gzip para JSONs > 4KB
app.use((req, res, next) => {
  const reqId = req.headers['x-request-id'] || generateRequestId();
  req.requestId = reqId;
  res.setHeader('X-Request-Id', reqId);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(k, v);
  }

  const origJson = res.json.bind(res);
  res.json = (payload) => {
    const acceptEnc = String(req.headers['accept-encoding'] || '');
    if (acceptEnc.includes('gzip')) {
      const raw = Buffer.from(JSON.stringify(payload));
      if (raw.length >= 4096) {
        try {
          const gz = zlib.gzipSync(raw, { level: 6 });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          res.setHeader('Content-Length', String(gz.length));
          return res.send(gz);
        } catch (_) {}
      }
    }
    return origJson(payload);
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_SEATS = 12;

// Pasta Oficial do Google Drive sincronizada automaticamente (FASE 3)
const OFFICIAL_DRIVE_FOLDER_ID = (
  process.env.GOOGLE_DRIVE_FOLDER_ID || '185iFV7I5x107sxJDTVbSxA9F0pY3GtTr'
).trim();
const OFFICIAL_DRIVE_FOLDER_URL = `https://drive.google.com/drive/folders/${OFFICIAL_DRIVE_FOLDER_ID}?usp=drive_link`;
const DRIVE_SYNC_INTERVAL_MS = Math.max(
  15000,
  parseInt(process.env.DRIVE_SYNC_INTERVAL_MS || '60000', 10) || 60000
);

// ==========================================
// FASE 10 — OBSERVABILIDADE, CORRELATION IDS E MÉTRICAS EM TEMPO REAL
// ==========================================
const recentObservabilityLogs = [];
const MAX_OBSERVABILITY_LOGS = 200;

const platformMetrics = {
  startedAt: new Date().toISOString(),
  activeClientStreams: 0,
  totalStreamRequests: 0,
  headCacheHits: 0,
  tailCacheHits: 0,
  metaCacheHits: 0,
  probeCacheHits: 0,
  recentTtfbMs: [],
  lastAutoSync: {
    officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
    officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
    status: 'idle',
    lastStartedAt: null,
    lastCompletedAt: null,
    lastTrigger: null,
    discoveredCount: 0,
    addedCount: 0,
    removedCount: 0,
    updatedCount: 0,
    durationMs: 0,
    error: null
  }
};

function recordTtfbMetric(ttfbMs, source) {
  const val = Math.max(0, Math.round(Number(ttfbMs) || 0));
  platformMetrics.recentTtfbMs.push({ ttfbMs: val, source, at: Date.now() });
  if (platformMetrics.recentTtfbMs.length > 60) {
    platformMetrics.recentTtfbMs.shift();
  }
}

function logStructured(category, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    category,
    event,
    ...details
  };
  recentObservabilityLogs.unshift(entry);
  if (recentObservabilityLogs.length > MAX_OBSERVABILITY_LOGS) {
    recentObservabilityLogs.pop();
  }
  const summaryPairs = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[${category}] ${event}${summaryPairs ? ' | ' + summaryPairs : ''}`);
}

app.use((req, res, next) => {
  const incomingCid = req.headers['x-correlation-id'];
  const correlationId =
    typeof incomingCid === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(incomingCid)
      ? incomingCid
      : `cp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
});

// ==========================================
// FASE 1 — CONTROLE DE ACESSO BASEADO EM PAPÉIS (RBAC: ADMIN vs USUÁRIO COMUM)
// ==========================================
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin-pompeia-2026').trim();
const ADMIN_TOKEN_SECRET =
  (process.env.ADMIN_TOKEN_SECRET || '').trim() ||
  crypto.createHash('sha256').update(`${ADMIN_PASSWORD}::cine_pompeia_rbac_v1`).digest('hex');
const revokedTokens = new Set();

function createAdminToken() {
  const payloadObj = {
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + 24 * 60 * 60 * 1000,
    jti: crypto.randomBytes(12).toString('hex')
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || revokedTokens.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || payload.role !== 'admin' || !payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers['x-admin-token'] || '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (typeof authHeader === 'string' && authHeader.includes('.')) {
    return authHeader.trim();
  }
  return '';
}

function isRequestAdmin(req) {
  const token = extractBearerToken(req);
  return Boolean(verifyAdminToken(token));
}

// Middleware obrigatório para proteger todas as rotas administrativas de escrita/sincronização
function requireAdmin(req, res, next) {
  if (!isRequestAdmin(req)) {
    console.warn(`[RBAC Block] Tentativa de acesso não autorizado a ${req.method} ${req.originalUrl}`);
    return res.status(403).json({
      error: 'Acesso negado: esta operação é restrita ao Administrador.',
      roleRequired: 'admin'
    });
  }
  next();
}

const localLoginAttemptsByIp = new Map();
const LOCAL_LOGIN_RATE_LIMIT_MAX = 8;
const LOCAL_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/auth/login', (req, res) => {
  const clientIp =
    (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : '') ||
    req.socket.remoteAddress ||
    'unknown';
  const now = Date.now();
  const rec = localLoginAttemptsByIp.get(clientIp);
  if (rec && now - rec.firstAt <= LOCAL_LOGIN_RATE_LIMIT_WINDOW_MS && rec.count >= LOCAL_LOGIN_RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((LOCAL_LOGIN_RATE_LIMIT_WINDOW_MS - (now - rec.firstAt)) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'Muitas tentativas de login. Aguarde antes de tentar novamente.' });
  }

  const password = String((req.body && req.body.password) || '').trim();
  if (!password) {
    return res.status(400).json({ error: 'Informe a senha de administrador.' });
  }
  const passBuf = Buffer.from(password);
  const adminBuf = Buffer.from(ADMIN_PASSWORD);
  if (passBuf.length !== adminBuf.length || !crypto.timingSafeEqual(passBuf, adminBuf)) {
    if (!rec || now - rec.firstAt > LOCAL_LOGIN_RATE_LIMIT_WINDOW_MS) {
      localLoginAttemptsByIp.set(clientIp, { count: 1, firstAt: now });
    } else {
      rec.count += 1;
    }
    console.warn('[RBAC Auth] Falha de login administrativo (senha incorreta).');
    return res.status(401).json({ error: 'Senha de administrador incorreta.' });
  }
  localLoginAttemptsByIp.delete(clientIp);
  const token = createAdminToken();
  res.json({
    success: true,
    authenticated: true,
    role: 'admin',
    token
  });
});

app.get('/api/auth/me', (req, res) => {
  const isAdmin = isRequestAdmin(req);
  res.json({
    authenticated: isAdmin,
    role: isAdmin ? 'admin' : 'user'
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractBearerToken(req);
  if (token) revokedTokens.add(token);
  res.json({ success: true, role: 'user' });
});

// ==========================================
// BANCO DE DADOS DO CATÁLOGO GOOGLE DRIVE (drive_catalog.json)
// ==========================================
const DRIVE_CATALOG_FILE = path.join(__dirname, 'drive_catalog.json');
const PUBLIC_CATALOG_FILE = path.join(__dirname, 'public', 'drive_catalog.json');
const PREPARED_MEDIA_DIR = path.join(__dirname, 'prepared_media');
const PUBLIC_MEDIA_CACHE_DIR = path.join(__dirname, 'public', 'media_cache');

// Catálogo inicial de exemplo (o usuário pode excluir ou substituir pelos vídeos do Drive de 5TB dele)
const DEFAULT_DRIVE_CATALOG = {
  folders: [],
  removedMovies: [],
  driveChangesPageToken: null,
  lastReconciledAt: null,
  movies: [
    {
      id: 'demo_1',
      title: 'Tears of Steel (Exemplo Stream Nativo HD)',
      year: '2012',
      rating: '8.1',
      category: 'Ficção & Fantasia',
      featured: true,
      driveFileId: null,
      rawUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
      streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
      poster: 'https://image.tmdb.org/t/p/w500/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg',
      overview: 'Vídeo de demonstração para testar a sincronia instantânea do Player Nativo CINE POMPEIA. Adicione seus filmes do Google Drive (5TB) clicando em "Gerenciar Meu Google Drive" no topo!',
      addedAt: Date.now()
    },
    {
      id: 'demo_2',
      title: 'Sintel (Exemplo Animação HD)',
      year: '2010',
      rating: '8.3',
      category: 'Animação & Família',
      featured: false,
      driveFileId: null,
      rawUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      poster: 'https://image.tmdb.org/t/p/w500/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/rkB4LyZHo1NHXFEDHl9vSD9r1lI.jpg',
      overview: 'Uma jovem guerreira chamada Sintel percorre terras perigosas em busca de seu pequeno dragão amigo Scales.',
      addedAt: Date.now() - 10000
    }
  ]
};

const os = require('os');
const TMP_CATALOG_FILE = path.join(os.tmpdir(), 'drive_catalog.json');

function ensureOfficialFolderInCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return;
  if (!Array.isArray(catalog.folders)) catalog.folders = [];
  const exists = catalog.folders.some((f) => f && f.folderId === OFFICIAL_DRIVE_FOLDER_ID);
  if (!exists && OFFICIAL_DRIVE_FOLDER_ID) {
    catalog.folders.unshift({
      folderId: OFFICIAL_DRIVE_FOLDER_ID,
      folderUrl: OFFICIAL_DRIVE_FOLDER_URL,
      official: true,
      syncedAt: new Date().toLocaleString('pt-BR')
    });
  }
}

function loadDriveCatalog() {
  for (const file of [DRIVE_CATALOG_FILE, TMP_CATALOG_FILE]) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.movies)) {
          const cat = {
            folders: Array.isArray(parsed.folders) ? parsed.folders : [],
            removedMovies: Array.isArray(parsed.removedMovies) ? parsed.removedMovies : [],
            driveChangesPageToken: parsed.driveChangesPageToken || null,
            lastReconciledAt: parsed.lastReconciledAt || null,
            movies: parsed.movies.filter((m) => m && m.id)
          };
          ensureOfficialFolderInCatalog(cat);
          return cat;
        }
      }
    } catch (_) {}
  }
  ensureOfficialFolderInCatalog(DEFAULT_DRIVE_CATALOG);
  return DEFAULT_DRIVE_CATALOG;
}

function saveDriveCatalog(catalog) {
  ensureOfficialFolderInCatalog(catalog);
  const json = JSON.stringify(catalog, null, 2);
  try {
    fs.writeFileSync(DRIVE_CATALOG_FILE, json, 'utf8');
  } catch (_) {}
  try {
    fs.writeFileSync(PUBLIC_CATALOG_FILE, json, 'utf8');
  } catch (_) {}
  try {
    fs.writeFileSync(TMP_CATALOG_FILE, json, 'utf8');
  } catch (_) {}
}

let driveCatalog = loadDriveCatalog();

// Extrai o ID do arquivo do Google Drive a partir de qualquer formato de link
function extractDriveFileId(input) {
  const str = String(input || '').trim();
  if (!str) return null;
  // Se o usuário colou apenas o ID puro do Drive (25 a 50 caracteres alfanuméricos/hífens)
  if (/^[a-zA-Z0-9_-]{25,55}$/.test(str)) {
    return str;
  }
  const matchFile = str.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (matchFile && matchFile[1]) return matchFile[1];
  const matchIdParam = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (matchIdParam && matchIdParam[1]) return matchIdParam[1];
  return null;
}

// Extrai o ID de uma pasta do Google Drive
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

function buildStreamUrl(rawUrl) {
  const fileId = extractDriveFileId(rawUrl);
  if (fileId && (String(rawUrl).includes('drive.google.com') || /^[a-zA-Z0-9_-]{25,55}$/.test(String(rawUrl).trim()))) {
    return `/api/gdrive/stream/${fileId}`;
  }
  return String(rawUrl || '').trim();
}

// Limpa o nome de um arquivo de vídeo (ex: "Interestelar.2014.1080p.Dublado.mkv" -> { title: "Interestelar", year: "2014" })
function parseMovieFilename(filename) {
  let clean = String(filename || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\.(mp4|mkv|webm|avi|mov|m4v)$/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(\s*(?:SeriesZoiudo|Dublado|Legendado|Dual|1080p|720p)[^)]*\)/gi, ' ')
    .replace(/[._]/g, ' ')
    .replace(/^\s*\d{1,3}\s*[-.]\s*/, '');

  if (/^p\s*d$/i.test(clean.trim())) {
    return { title: 'Chicago P.D.: Distrito 21', year: '2014' };
  }
  if (/acceleracers\s*1/i.test(clean)) {
    return { title: 'Hot Wheels AcceleRacers 1: Ignição', year: '2005' };
  }
  if (/acceleracers\s*2/i.test(clean)) {
    return { title: 'Hot Wheels AcceleRacers 2: A Velocidade do Silêncio', year: '2005' };
  }
  if (/acceleracers\s*3/i.test(clean)) {
    return { title: 'Hot Wheels AcceleRacers 3: Ponto de Ruptura', year: '2005' };
  }
  if (/acceleracers\s*4/i.test(clean)) {
    return { title: 'Hot Wheels AcceleRacers 4: A Corrida Final', year: '2005' };
  }

  const yearMatch = clean.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : '';

  // Remove tags técnicas comuns após o ano ou no final
  clean = clean
    .replace(
      /\b(open\s*matte|imax|remastered|full\s*hd|1080p|720p|2160p|4k|blu-?ray|brrip|bdrip|web-?dl|webrip|hdrip|dvdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|dd5\s*1|5\s*1|6ch|2ch|dts|dual|dublado|legendado|pt-?br|brshares|totti9|210gji|andretpf|starckfilmes|comandotorrents|wolverdonfilmes|xfilme|tdf|mld)\b.*/i,
      ''
    )
    .replace(/\s+-\s+[a-z0-9_]{3,20}\s*$/i, '')
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

function computeTitleSimilarity(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.88;
  const wordsA = new Set(na.split(' ').filter((w) => w.length > 1));
  const wordsB = new Set(nb.split(' ').filter((w) => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap += 1;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// Busca automática de capa/sinopse pelo título (TMDB PT-BR + Apple iTunes Brasil API + Fallback Frame FFmpeg)
async function fetchMetadataByTitle(title, year, driveFileId = null) {
  if (!title) return null;
  const tmdbKey = (process.env.TMDB_API_KEY || '').trim();

  if (tmdbKey) {
    try {
      const url = new URL('https://api.themoviedb.org/3/search/multi');
      url.searchParams.set('api_key', tmdbKey);
      url.searchParams.set('language', 'pt-BR');
      url.searchParams.set('query', title);
      if (year) url.searchParams.set('year', year);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3200);
      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const hit =
          (data.results || []).find((r) => r.media_type === 'movie' || r.media_type === 'tv') ||
          (data.results || [])[0];
        if (hit && hit.poster_path) {
          const genreMap = {
            28: 'Ação & Aventura',
            12: 'Ação & Aventura',
            878: 'Ficção & Fantasia',
            14: 'Ficção & Fantasia',
            27: 'Terror & Suspense',
            53: 'Terror & Suspense',
            35: 'Comédia',
            16: 'Animação & Família',
            10751: 'Animação & Família',
            18: 'Drama & Aclamados'
          };
          const firstGenreId = Array.isArray(hit.genre_ids) && hit.genre_ids[0];
          const category =
            hit.media_type === 'tv'
              ? 'Séries & Episódios'
              : genreMap[firstGenreId] || 'Lançamentos & Destaques';
          const hitTitle = hit.title || hit.name || title;
          const sim = computeTitleSimilarity(title, hitTitle);

          return {
            title: hitTitle,
            year: (hit.release_date || hit.first_air_date || year || '').slice(0, 4),
            rating: hit.vote_average ? hit.vote_average.toFixed(1) : '8.5',
            category,
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

  // Fallback 2: Apple iTunes Movies API Brasil (PT-BR, sem necessidade de API Key)
  try {
    const itunesUrl = new URL('https://itunes.apple.com/search');
    itunesUrl.searchParams.set('term', year ? `${title} ${year}` : title);
    itunesUrl.searchParams.set('country', 'BR');
    itunesUrl.searchParams.set('media', 'movie');
    itunesUrl.searchParams.set('entity', 'movie');
    itunesUrl.searchParams.set('limit', '5');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(itunesUrl.toString(), { signal: controller.signal });
    clearTimeout(timer);
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

  // Fallback 3: Frame representativo extraído do próprio vídeo via FFmpeg
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

// ==========================================
// ROTAS DO CATÁLOGO DE STREAMING DO GOOGLE DRIVE
// ==========================================

function enrichMovieWithPlaybackInfo(movie) {
  if (!movie || !movie.driveFileId) return movie;
  const fileId = movie.driveFileId;
  const cachedDiag = codecProbeCache.get(fileId) || (mediaRegistry && mediaRegistry.files && mediaRegistry.files[fileId]);
  const posterFallbackUrl = `/media_cache/${fileId}/poster_fallback.jpg`;
  const cleanPoster =
    movie.poster && !movie.poster.includes('placehold.co') ? movie.poster : posterFallbackUrl;

  if (!cachedDiag) {
    return {
      ...movie,
      poster: cleanPoster,
      posterFallbackUrl,
      duration: Number(movie.duration) || 0,
      container: /\.mkv$/i.test(movie.driveFileName || movie.fileName || '') ? 'mkv' : 'mp4',
      requiresAudioFallbackOrRemux: false,
      recommendedCustomPlayerUrl: `/api/videos/${fileId}/stream`
    };
  }

  const duration = Number(cachedDiag.duration || cachedDiag.durationSec) || 0;
  const preparedMp4 = getPreparedMp4Path(fileId, 0);
  const hasCompatMp4 = Boolean(cachedDiag.hasCompatMp4 || preparedMp4);
  const audioTracks = Array.isArray(cachedDiag.audioTracks) ? cachedDiag.audioTracks : [];
  const primaryTrackCompat =
    cachedDiag.container !== 'avi' &&
    (audioTracks.length > 0
      ? Boolean(audioTracks[0].browserSupported)
      : (cachedDiag.audioCodecs || []).some((c) => ['AAC', 'Opus', 'Vorbis', 'MP3'].includes(c)));
  const hasSidecarHls0 =
    Boolean(cachedDiag.sidecarAudioHlsUrl) ||
    fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'audio_0', 'index.m3u8'));
  const hasSidecarAudio0 =
    hasSidecarHls0 ||
    Boolean(cachedDiag.hasSidecarAudio0) ||
    fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'audio_0.m4a'));
  const sidecarAudioHlsUrl = hasSidecarHls0
    ? `/media_cache/${fileId}/audio_0/index.m3u8`
    : null;
  const sidecarAudioUrl = sidecarAudioHlsUrl
    ? sidecarAudioHlsUrl
    : hasSidecarAudio0
    ? `/media_cache/${fileId}/audio_0.m4a`
    : `/api/videos/${fileId}/audio-stream.m4a?track=0`;

  let recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream`;
  if (cachedDiag.hasCompatMp4 && fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'compat.mp4'))) {
    recommendedCustomPlayerUrl = `/media_cache/${fileId}/compat.mp4`;
  } else if (preparedMp4) {
    recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream?compat=1&audioTrack=0`;
  }

  return {
    ...movie,
    poster: cleanPoster,
    posterFallbackUrl,
    duration: duration > 0 ? duration : movie.duration || 0,
    container: cachedDiag.container || movie.container || 'mp4',
    videoCodecs: cachedDiag.videoCodecs || ['H.264 (AVC)'],
    audioCodecs: cachedDiag.audioCodecs || ['AAC'],
    hasSidecarAudio0,
    sidecarAudioHlsUrl,
    sidecarAudioUrl,
    sidecarAudioDurationSec: Number(cachedDiag.sidecarAudioDurationSec || 0),
    sidecarAudioComplete: hasSidecarHls0 || cachedDiag.sidecarAudioComplete !== false,
    isEbmlRemappableDual: Boolean(cachedDiag.isEbmlRemappableDual),
    requiresSidecarAudio: !primaryTrackCompat && cachedDiag.container !== 'avi' && !preparedMp4,
    requiresAudioFallbackOrRemux: hasCompatMp4,
    recommendedCustomPlayerUrl
  };
}

// Retorna o catálogo organizado em fileiras estilo Netflix/Prime Video
app.get('/api/drive/catalog', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  const { query = '', category = 'all', includeUnavailable = 'false' } = req.query;
  const q = String(query).toLowerCase().trim();
  const isAdmin = isRequestAdmin(req);

  let movies = [...driveCatalog.movies]
    .filter((m) => (isAdmin && includeUnavailable === 'true' ? true : !m.unavailable && !m.trashed))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .map(enrichMovieWithPlaybackInfo);

  if (category && category !== 'all') {
    movies = movies.filter((m) => (m.category || '').toLowerCase() === String(category).toLowerCase());
  }

  if (q) {
    movies = movies.filter(
      (m) =>
        (m.title || '').toLowerCase().includes(q) ||
        (m.category || '').toLowerCase().includes(q) ||
        (m.year || '').includes(q)
    );
  }

  const hero =
    movies.find((m) => m.featured && m.backdrop) ||
    movies.find((m) => m.backdrop) ||
    movies[0] ||
    null;

  // Agrupa os filmes do Google Drive em trilhos (carrosséis) estilo Streaming
  const rows = [];

  if (movies.length > 0) {
    rows.push({
      id: 'recent_drive',
      title: '☁️ Adicionados Recentemente no Seu Google Drive',
      style: 'top10',
      items: movies.slice(0, 10)
    });
  }

  const categoriesMap = new Map();
  for (const movie of movies) {
    const cat = movie.category || 'Filmes no Google Drive';
    if (!categoriesMap.has(cat)) {
      categoriesMap.set(cat, []);
    }
    categoriesMap.get(cat).push(movie);
  }

  for (const [catName, items] of categoriesMap.entries()) {
    rows.push({
      id: `cat_${catName}`,
      title: `🎬 ${catName}`,
      style: 'standard',
      items
    });
  }

  res.json({
    totalMovies: movies.length,
    officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
    officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
    autoSync: platformMetrics.lastAutoSync,
    folders: driveCatalog.folders || [],
    lastReconciledAt: driveCatalog.lastReconciledAt || null,
    removedCount: Array.isArray(driveCatalog.removedMovies) ? driveCatalog.removedMovies.length : 0,
    hero,
    movies,
    rows
  });
});

// Auto-preenchimento de Capa e Sinopse quando o administrador digita o nome do filme que subiu no Drive
app.get('/api/drive/autofill', async (req, res) => {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: 'Informe o nome do filme.' });
  const parsed = parseMovieFilename(title);
  const meta = await fetchMetadataByTitle(parsed.title, parsed.year);
  if (!meta) {
    return res.status(404).json({ error: 'Capa não encontrada automaticamente. Você pode preencher manualmente.' });
  }
  res.json(meta);
});

// Adicionar ou editar um Filme do Google Drive (PROTEGIDO POR RBAC: APENAS ADMINISTRADOR)
app.post('/api/drive/movies', requireAdmin, async (req, res) => {
  try {
    const {
      id,
      title,
      rawUrl,
      category = 'Lançamentos & Destaques',
      year = '',
      rating = '8.5',
      poster = '',
      backdrop = '',
      overview = '',
      featured = false,
      autoFetchCover = true
    } = req.body;

    if (!title || !rawUrl) {
      return res.status(400).json({ error: 'Informe o título do filme e o link do Google Drive.' });
    }

    const driveFileId = extractDriveFileId(rawUrl);
    const streamUrl = buildStreamUrl(rawUrl);

    let finalTitle = String(title).trim();
    let finalYear = String(year || '').trim();
    let finalRating = String(rating || '8.5').trim();
    let finalCategory = String(category || 'Lançamentos & Destaques').trim();
    let finalPoster = String(poster || '').trim();
    let finalBackdrop = String(backdrop || '').trim();
    let finalOverview = String(overview || '').trim();

    if (autoFetchCover && (!finalPoster || !finalBackdrop || !finalOverview)) {
      const parsed = parseMovieFilename(finalTitle);
      const meta = await fetchMetadataByTitle(parsed.title, finalYear || parsed.year);
      if (meta) {
        if (!finalPoster && meta.poster) finalPoster = meta.poster;
        if (!finalBackdrop && meta.backdrop) finalBackdrop = meta.backdrop;
        if (!finalOverview && meta.overview) finalOverview = meta.overview;
        if (!finalYear && meta.year) finalYear = meta.year;
        if (meta.rating) finalRating = meta.rating;
        if (finalCategory === 'Auto' && meta.category) finalCategory = meta.category;
      }
    }

    if (!finalPoster) {
      finalPoster = `https://placehold.co/500x750/151828/f5c518?text=${encodeURIComponent(finalTitle)}`;
    }
    if (!finalBackdrop) {
      finalBackdrop = finalPoster;
    }
    if (!finalOverview) {
      finalOverview = 'Filme armazenado no seu Google Drive pessoal pronto para reprodução sincronizada.';
    }

    const movieObj = {
      id: id || (driveFileId ? `drive_${driveFileId}` : `drive_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
      title: finalTitle,
      year: finalYear || new Date().getFullYear().toString(),
      rating: finalRating,
      category: finalCategory === 'Auto' ? 'Lançamentos & Destaques' : finalCategory,
      featured: Boolean(featured),
      driveFileId,
      rawUrl: String(rawUrl).trim(),
      streamUrl,
      poster: finalPoster,
      backdrop: finalBackdrop,
      overview: finalOverview,
      addedAt: Date.now()
    };

    const existingIdx = driveCatalog.movies.findIndex(
      (m) => m.id === movieObj.id || (driveFileId && m.driveFileId === driveFileId)
    );
    if (existingIdx >= 0) {
      driveCatalog.movies[existingIdx] = {
        ...driveCatalog.movies[existingIdx],
        ...movieObj,
        id: driveCatalog.movies[existingIdx].id
      };
    } else {
      driveCatalog.movies.unshift(movieObj);
    }

    saveDriveCatalog(driveCatalog);
    io.emit('catalog_synced', { movies: driveCatalog.movies });
    res.json({ success: true, movie: movieObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar informações de um filme existente no catálogo (PROTEGIDO POR RBAC: APENAS ADMINISTRADOR)
app.put('/api/drive/movies/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const idx = driveCatalog.movies.findIndex((m) => m.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Filme não encontrado no catálogo.' });
  }
  const existing = driveCatalog.movies[idx];
  const { title, year, rating, category, poster, backdrop, overview, featured } = req.body || {};

  driveCatalog.movies[idx] = {
    ...existing,
    title: title !== undefined ? String(title).trim() : existing.title,
    year: year !== undefined ? String(year).trim() : existing.year,
    rating: rating !== undefined ? String(rating).trim() : existing.rating,
    category: category !== undefined ? String(category).trim() : existing.category,
    poster: poster !== undefined ? String(poster).trim() : existing.poster,
    backdrop: backdrop !== undefined ? String(backdrop).trim() : existing.backdrop,
    overview: overview !== undefined ? String(overview).trim() : existing.overview,
    featured: featured !== undefined ? Boolean(featured) : existing.featured,
    updatedAt: Date.now()
  };

  saveDriveCatalog(driveCatalog);
  io.emit('catalog_synced', { movies: driveCatalog.movies });
  res.json({ success: true, movie: driveCatalog.movies[idx] });
});

// Remover um filme do catálogo do Drive (PROTEGIDO POR RBAC: APENAS ADMINISTRADOR)
app.delete('/api/drive/movies/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const target = driveCatalog.movies.find((m) => m.id === id || m.driveFileId === id);
  if (!target) {
    return res.status(404).json({ error: 'Filme não encontrado no catálogo.' });
  }
  if (target.driveFileId) {
    driveMetaCache.delete(target.driveFileId);
    codecProbeCache.delete(target.driveFileId);
  }
  driveCatalog.movies = driveCatalog.movies.filter((m) => m.id !== id && m.driveFileId !== id);
  if (!Array.isArray(driveCatalog.removedMovies)) driveCatalog.removedMovies = [];
  driveCatalog.removedMovies.unshift({
    id: target.id,
    driveFileId: target.driveFileId,
    title: target.title,
    reason: 'removed_by_admin',
    removedAt: new Date().toISOString()
  });
  saveDriveCatalog(driveCatalog);
  io.emit('catalog_synced', { movies: driveCatalog.movies, removedIds: [target.id] });
  res.json({ success: true, removedId: target.id });
});

function cleanupRemovedMovieMediaCache(fileId) {
  if (!isValidDriveFileId(fileId)) return;
  driveMetaCache.delete(fileId);
  codecProbeCache.delete(fileId);
  if (mediaRegistry && mediaRegistry.files && mediaRegistry.files[fileId]) {
    delete mediaRegistry.files[fileId];
    saveMediaRegistry();
  }
}

// Lista arquivos de uma pasta do Google Drive via API v3 (com paginação completa) ou embeddedfolderview
async function fetchDriveFolderFiles(folderId) {
  const googleApiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  const googleOAuthToken = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();

  if (googleApiKey || googleOAuthToken) {
    try {
      const allApiFiles = [];
      let nextPageToken = null;
      let pageSafety = 0;

      do {
        pageSafety += 1;
        const apiUrl = new URL('https://www.googleapis.com/drive/v3/files');
        apiUrl.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
        apiUrl.searchParams.set(
          'fields',
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,trashed,parents,videoMediaMetadata)'
        );
        apiUrl.searchParams.set('pageSize', '200');
        apiUrl.searchParams.set('supportsAllDrives', 'true');
        apiUrl.searchParams.set('includeItemsFromAllDrives', 'true');
        if (nextPageToken) apiUrl.searchParams.set('pageToken', nextPageToken);
        if (googleApiKey && !googleOAuthToken) apiUrl.searchParams.set('key', googleApiKey);

        const headers = {};
        if (googleOAuthToken) headers.Authorization = `Bearer ${googleOAuthToken}`;

        const apiRes = await fetch(apiUrl.toString(), { headers });
        if (apiRes.status >= 500 || apiRes.status === 429) {
          return {
            ok: false,
            temporaryError: true,
            status: apiRes.status,
            error: 'Erro temporário na Google Drive API v3.'
          };
        }
        if (!apiRes.ok) break;

        const data = await apiRes.json();
        for (const f of data.files || []) {
          const isVideoMime = f.mimeType && f.mimeType.startsWith('video/');
          const isVideoExt = /\.(mp4|mkv|webm|avi|mov|m4v)$/i.test(f.name || '');
          const isExcludedExt = /\.(jpg|jpeg|png|gif|srt|vtt|txt|nfo|pdf|zip|rar)$/i.test(f.name || '');
          if (!f.trashed && (isVideoMime || (isVideoExt && !isExcludedExt) || (!f.mimeType && !isExcludedExt))) {
            allApiFiles.push({
              fileId: f.id,
              fileName: f.name,
              mimeType: f.mimeType || null,
              size: Number(f.size) || 0,
              modifiedTime: f.modifiedTime || null,
              createdTime: f.createdTime || null,
              durationMillis: f.videoMediaMetadata && f.videoMediaMetadata.durationMillis
                ? Number(f.videoMediaMetadata.durationMillis)
                : 0
            });
          }
        }
        nextPageToken = data.nextPageToken || null;
      } while (nextPageToken && pageSafety < 15);

      if (allApiFiles.length > 0) {
        return { ok: true, status: 200, source: 'drive_api_v3', files: allApiFiles };
      }
    } catch (_) {}
  }

  const embedListUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
  try {
    const response = await fetch(embedListUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.status >= 500 || response.status === 429) {
      return {
        ok: false,
        temporaryError: true,
        status: response.status,
        error: `Falha temporária no Google Drive (${response.status}).`
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        temporaryError: false,
        status: response.status,
        error: 'Não foi possível ler a pasta. Verifique se ela está compartilhada como "Qualquer pessoa com o link pode ver".'
      };
    }

    const html = await response.text();
    const entryRegex = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
    const discoveredFiles = [];
    let match;
    while ((match = entryRegex.exec(html)) !== null) {
      const fileId = match[1];
      const fileName = match[2]
        .replace(/&amp;/gi, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/gi, '"')
        .trim();
      if (!/\.(jpg|jpeg|png|gif|srt|vtt|txt|nfo|pdf|zip|rar)$/i.test(fileName)) {
        discoveredFiles.push({ fileId, fileName });
      }
    }

    return {
      ok: true,
      status: 200,
      source: 'embeddedfolderview',
      files: discoveredFiles
    };
  } catch (err) {
    return {
      ok: false,
      temporaryError: true,
      status: 503,
      error: 'Erro de rede ao consultar pasta do Google Drive: ' + err.message
    };
  }
}

// Motor unificado e idempotente de sincronização de pasta do Google Drive (FASE 3)
async function syncDriveFolderById(folderId, options = {}) {
  const {
    folderUrl = `https://drive.google.com/drive/folders/${folderId}?usp=drive_link`,
    defaultCategory = 'Auto',
    removeMissingFromFolder = true,
    trigger = 'manual'
  } = options;

  const syncStartMs = Date.now();
  const folderResult = await fetchDriveFolderFiles(folderId);
  if (!folderResult.ok) {
    logStructured('DRIVE_SYNC', 'folder_fetch_failed', {
      folderId,
      trigger,
      temporaryError: Boolean(folderResult.temporaryError),
      error: folderResult.error
    });
    return {
      ok: false,
      temporaryError: Boolean(folderResult.temporaryError),
      status: folderResult.temporaryError ? 503 : 400,
      error: folderResult.error
    };
  }

  const discoveredFiles = folderResult.files || [];
  if (discoveredFiles.length === 0) {
    return {
      ok: false,
      temporaryError: false,
      status: 400,
      error:
        'Nenhum arquivo de vídeo foi encontrado dentro desta pasta do Google Drive (certifique-se de que a pasta está pública e contém vídeos).'
    };
  }

  const discoveredIdsSet = new Set(discoveredFiles.map((f) => f.fileId));
  const discoveredByFileId = new Map(discoveredFiles.map((f) => [f.fileId, f]));

  // 1. Reconciliação de exclusões: remove filmes da pasta que foram excluídos, enviados para lixeira ou movidos
  const removedMoviesList = [];
  if (removeMissingFromFolder) {
    const isSingleSyncedFolder =
      !driveCatalog.folders ||
      driveCatalog.folders.length === 0 ||
      (driveCatalog.folders.length === 1 && driveCatalog.folders[0].folderId === folderId);

    driveCatalog.movies = driveCatalog.movies.filter((m) => {
      if (!m.driveFileId) return true;
      const belongsToThisFolder = m.folderId === folderId || (isSingleSyncedFolder && !m.folderId);
      if (belongsToThisFolder && !discoveredIdsSet.has(m.driveFileId)) {
        cleanupRemovedMovieMediaCache(m.driveFileId);
        removedMoviesList.push({
          id: m.id,
          driveFileId: m.driveFileId,
          title: m.title,
          reason: 'removed_from_synced_folder',
          removedAt: new Date().toISOString()
        });
        return false;
      }
      return true;
    });
  }

  // 2. Atualização de renomeações, tamanhos e metadados nos filmes já existentes na pasta
  let updatedCount = 0;
  for (const m of driveCatalog.movies) {
    if (!m.driveFileId || !discoveredIdsSet.has(m.driveFileId)) continue;
    if (!m.folderId) {
      m.folderId = folderId;
    }
    const remoteFile = discoveredByFileId.get(m.driveFileId);
    if (remoteFile) {
      if (remoteFile.fileName && m.fileName !== remoteFile.fileName) {
        const previousFileName = m.fileName;
        m.fileName = remoteFile.fileName;
        if (!m.customEdited) {
          const reParsed = parseMovieFilename(remoteFile.fileName);
          if (reParsed.title) m.title = reParsed.title;
          if (reParsed.year) m.year = reParsed.year;
        }
        updatedCount += 1;
        logStructured('DRIVE_SYNC', 'file_renamed_detected', {
          fileId: m.driveFileId,
          oldName: previousFileName || 'unknown',
          newName: remoteFile.fileName
        });
      }
      if (remoteFile.size && m.size !== remoteFile.size) {
        m.size = remoteFile.size;
      }
      if (remoteFile.modifiedTime && m.modifiedTime !== remoteFile.modifiedTime) {
        m.modifiedTime = remoteFile.modifiedTime;
      }
    }
  }

  // 3. Adição automática e idempotente de novos vídeos adicionados à pasta
  const newFiles = discoveredFiles.filter(
    (file) => !driveCatalog.movies.some((m) => m.driveFileId === file.fileId)
  );

  const createdMovies = await Promise.all(
    newFiles.map(async (file, idx) => {
      const parsed = parseMovieFilename(file.fileName);
      const meta = await fetchMetadataByTitle(parsed.title, parsed.year, file.fileId);

      return {
        id: `drive_${file.fileId}`,
        title: (meta && meta.title) || parsed.title,
        year: (meta && meta.year) || parsed.year,
        rating: (meta && meta.rating) || '8.0',
        category:
          defaultCategory !== 'Auto'
            ? defaultCategory
            : (meta && meta.category) || 'Filmes do Google Drive',
        featured: idx === 0 && driveCatalog.movies.length === 0,
        driveFileId: file.fileId,
        folderId,
        fileName: file.fileName,
        size: file.size || 0,
        modifiedTime: file.modifiedTime || null,
        rawUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
        streamUrl: `/api/gdrive/stream/${file.fileId}`,
        poster:
          (meta && meta.poster) || `/media_cache/${file.fileId}/poster_fallback.jpg`,
        backdrop:
          (meta && meta.backdrop) ||
          (meta && meta.poster) ||
          `/media_cache/${file.fileId}/poster_fallback.jpg`,
        posterFallbackUrl: `/media_cache/${file.fileId}/poster_fallback.jpg`,
        posterSource: (meta && meta.posterSource) || 'ffmpeg_frame_fallback',
        matchScore: (meta && meta.matchScore) || 0.9,
        needsReview: Boolean(meta && meta.needsReview),
        overview:
          (meta && meta.overview) ||
          `Arquivo sincronizado da pasta oficial do Google Drive (${file.fileName}).`,
        stages: {
          imported: true,
          metadata: Boolean(meta),
          poster: true,
          codecs: false,
          audio_compat: false,
          thumbnails: false,
          ready: false
        },
        addedAt: Date.now() - idx
      };
    })
  );

  for (const newMovie of createdMovies) {
    driveCatalog.movies.unshift(newMovie);
  }
  const addedCount = createdMovies.length;

  const existingFolderIdx = driveCatalog.folders.findIndex((f) => f.folderId === folderId);
  const folderEntry = {
    folderId,
    folderUrl,
    official: folderId === OFFICIAL_DRIVE_FOLDER_ID,
    syncedAt: new Date().toLocaleString('pt-BR')
  };
  if (existingFolderIdx >= 0) {
    driveCatalog.folders[existingFolderIdx] = folderEntry;
  } else {
    driveCatalog.folders.push(folderEntry);
  }

  if (removedMoviesList.length > 0) {
    if (!Array.isArray(driveCatalog.removedMovies)) driveCatalog.removedMovies = [];
    driveCatalog.removedMovies.unshift(...removedMoviesList);
  }
  driveCatalog.lastReconciledAt = new Date().toISOString();

  if (addedCount > 0 || removedMoviesList.length > 0 || updatedCount > 0 || trigger === 'manual') {
    saveDriveCatalog(driveCatalog);
  }

  if (addedCount > 0 || removedMoviesList.length > 0 || updatedCount > 0 || trigger === 'manual') {
    io.emit('catalog_synced', {
      movies: driveCatalog.movies.map(enrichMovieWithPlaybackInfo),
      removedIds: removedMoviesList.map((r) => r.id),
      addedCount,
      updatedCount,
      trigger
    });
  }

  const durationMs = Date.now() - syncStartMs;
  logStructured('DRIVE_SYNC', 'folder_sync_completed', {
    folderId,
    trigger,
    source: folderResult.source,
    discoveredCount: discoveredFiles.length,
    addedCount,
    removedCount: removedMoviesList.length,
    updatedCount,
    durationMs
  });

  // Se novos filmes entraram, agenda aquecimento leve de metadados/codecs quando o servidor estiver ocioso
  if (addedCount > 0) {
    setImmediate(() => scheduleIdleCatalogWarmup());
  }

  return {
    ok: true,
    success: true,
    source: folderResult.source,
    discoveredCount: discoveredFiles.length,
    addedCount,
    updatedCount,
    removedCount: removedMoviesList.length,
    removedMovies: removedMoviesList,
    totalMovies: driveCatalog.movies.length,
    durationMs,
    movies: driveCatalog.movies.map(enrichMovieWithPlaybackInfo)
  };
}

let isAutoSyncRunning = false;

async function runAutomaticDriveFolderSync(trigger = 'scheduler') {
  if (isAutoSyncRunning) {
    return { skipped: true, reason: 'sync_already_in_progress' };
  }
  isAutoSyncRunning = true;
  platformMetrics.lastAutoSync.status = 'running';
  platformMetrics.lastAutoSync.lastStartedAt = new Date().toISOString();
  platformMetrics.lastAutoSync.lastTrigger = trigger;

  try {
    const result = await syncDriveFolderById(OFFICIAL_DRIVE_FOLDER_ID, {
      folderUrl: OFFICIAL_DRIVE_FOLDER_URL,
      defaultCategory: 'Auto',
      removeMissingFromFolder: true,
      trigger
    });

    platformMetrics.lastAutoSync = {
      officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
      officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
      status: result.ok ? 'completed' : 'error',
      lastStartedAt: platformMetrics.lastAutoSync.lastStartedAt,
      lastCompletedAt: new Date().toISOString(),
      lastTrigger: trigger,
      discoveredCount: result.discoveredCount || 0,
      addedCount: result.addedCount || 0,
      removedCount: result.removedCount || 0,
      updatedCount: result.updatedCount || 0,
      durationMs: result.durationMs || 0,
      error: result.error || null
    };
    return result;
  } catch (err) {
    platformMetrics.lastAutoSync.status = 'error';
    platformMetrics.lastAutoSync.error = err.message;
    platformMetrics.lastAutoSync.lastCompletedAt = new Date().toISOString();
    return { ok: false, error: err.message };
  } finally {
    isAutoSyncRunning = false;
  }
}

// Sincronizar uma PASTA INTEIRA compartilhada do Google Drive (PROTEGIDO POR RBAC: APENAS ADMINISTRADOR)
app.post('/api/drive/sync-folder', requireAdmin, async (req, res) => {
  try {
    const {
      folderUrl = OFFICIAL_DRIVE_FOLDER_URL,
      defaultCategory = 'Auto',
      removeMissingFromFolder = true
    } = req.body || {};
    const folderId = extractDriveFolderId(folderUrl) || OFFICIAL_DRIVE_FOLDER_ID;

    if (!folderId) {
      return res.status(400).json({
        error: 'Link de pasta inválido. Cole um link do tipo: https://drive.google.com/drive/folders/ID_DA_PASTA'
      });
    }

    const result = await syncDriveFolderById(folderId, {
      folderUrl: folderUrl || `https://drive.google.com/drive/folders/${folderId}`,
      defaultCategory,
      removeMissingFromFolder,
      trigger: 'manual'
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sincronizar pasta do Drive: ' + err.message });
  }
});

// Status público/admin da sincronização automática da pasta oficial 185iFV7I5x107sxJDTVbSxA9F0pY3GtTr
app.get('/api/drive/sync-status', (req, res) => {
  res.json({
    officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
    officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
    syncIntervalMs: DRIVE_SYNC_INTERVAL_MS,
    isAutoSyncRunning,
    lastAutoSync: platformMetrics.lastAutoSync,
    totalMovies: driveCatalog.movies.length,
    lastReconciledAt: driveCatalog.lastReconciledAt || null
  });
});

// Receptor de Webhooks Push Notifications do Google Drive (changes.watch) — FASE 3.3
app.post('/api/drive/webhook', (req, res) => {
  const resourceState = req.headers['x-goog-resource-state'] || 'change';
  const channelId = req.headers['x-goog-channel-id'] || 'unknown';
  const resourceId = req.headers['x-goog-resource-id'] || 'unknown';

  logStructured('DRIVE_SYNC', 'webhook_notification_received', {
    resourceState,
    channelId,
    resourceId
  });

  if (resourceState !== 'sync') {
    setImmediate(() => {
      runAutomaticDriveFolderSync(`webhook:${resourceState}`).catch(() => {});
    });
  }
  res.status(200).json({ received: true, resourceState });
});

// Registro/renovação de canal Push Notification (changes.watch) na Google Drive API v3
app.post('/api/drive/watch', requireAdmin, async (req, res) => {
  const googleOAuthToken = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();
  const webhookAddress = String((req.body && req.body.webhookUrl) || process.env.GOOGLE_DRIVE_WEBHOOK_URL || '').trim();

  if (!googleOAuthToken || !webhookAddress) {
    return res.status(200).json({
      success: true,
      mode: 'polling_scheduler_active',
      officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
      syncIntervalMs: DRIVE_SYNC_INTERVAL_MS,
      message:
        'Sincronização automática periódica ativa a cada ' +
        Math.round(DRIVE_SYNC_INTERVAL_MS / 1000) +
        's. Para webhooks push (changes.watch), defina GOOGLE_OAUTH_ACCESS_TOKEN e GOOGLE_DRIVE_WEBHOOK_URL HTTPS.'
    });
  }

  try {
    let pageToken = driveCatalog.driveChangesPageToken;
    if (!pageToken) {
      const startRes = await fetch(
        'https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true',
        { headers: { Authorization: `Bearer ${googleOAuthToken}` } }
      );
      if (startRes.ok) {
        const sData = await startRes.json();
        pageToken = sData.startPageToken;
        driveCatalog.driveChangesPageToken = pageToken;
        saveDriveCatalog(driveCatalog);
      }
    }

    const watchUrl = `https://www.googleapis.com/drive/v3/changes/watch?pageToken=${encodeURIComponent(
      pageToken || '1'
    )}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const channelBody = {
      id: `cine-pompeia-watch-${Date.now()}`,
      type: 'web_hook',
      address: webhookAddress,
      expiration: String(Date.now() + 7 * 24 * 3600 * 1000)
    };

    const watchRes = await fetch(watchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${googleOAuthToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(channelBody)
    });
    const watchData = await watchRes.json().catch(() => ({}));
    if (!watchRes.ok) {
      return res.status(watchRes.status).json({ error: 'Falha ao registrar changes.watch', details: watchData });
    }
    res.json({ success: true, mode: 'webhook_and_scheduler', channel: watchData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FASE 8 — Diagnóstico de Saúde por Filme para o Painel Administrativo
app.get('/api/admin/movies-health', requireAdmin, (req, res) => {
  const movies = (driveCatalog.movies || []).map(enrichMovieWithPlaybackInfo);
  const items = movies.map((m) => {
    const fileId = m.driveFileId;
    const regEntry =
      (mediaRegistry && mediaRegistry.files && mediaRegistry.files[fileId]) ||
      codecProbeCache.get(fileId) ||
      null;
    const hasOriginal = Boolean(fileId && (!regEntry || (regEntry.size || (regEntry.driveMeta && regEntry.driveMeta.size) || 0) > 0));
    const hasMeta = Boolean(m.title && m.year && m.overview);
    const hasPoster = Boolean(m.poster && !m.poster.includes('placehold.co'));
    const vCodec =
      (regEntry && regEntry.videoCodecs && regEntry.videoCodecs.join(', ')) || 'H.264 (AVC)';
    const aCodec =
      (regEntry && regEntry.audioCodecs && regEntry.audioCodecs.join(', ')) || 'AAC';
    const hasSidecar = Boolean(
      (regEntry && regEntry.hasSidecarAudio0) ||
        fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId || '', 'audio_0.m4a'))
    );
    const hasCompatMp4 = Boolean(
      (regEntry && regEntry.hasCompatMp4) ||
        fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId || '', 'compat.mp4')) ||
        getPreparedMp4Path(fileId, 0)
    );
    const primaryCompat = Boolean(
      !regEntry ||
        regEntry.primaryTrackCompat ||
        regEntry.browserAudioSupported ||
        (regEntry.audioTracks && regEntry.audioTracks[0] && regEntry.audioTracks[0].browserSupported)
    );
    const compatAvailable = Boolean(
      primaryCompat ||
        (regEntry && regEntry.isEbmlRemappableDual) ||
        hasSidecar ||
        hasCompatMp4
    );
    const compatMode = primaryCompat
      ? 'native_aac_opus_mp3'
      : regEntry && regEntry.isEbmlRemappableDual
      ? 'ebml_dual_aac_plus_sidecar_ptbr'
      : hasSidecar
      ? 'sidecar_aac_m4a'
      : hasCompatMp4
      ? 'compat_mp4_h264_aac'
      : 'on_demand_ffmpeg_aac';
    const hasThumbs = Boolean(
      fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId || '', 'sprite.jpg')) ||
        (regEntry && regEntry.hasThumbnailsSprite)
    );

    const errors = [];
    if (!hasOriginal) errors.push('Arquivo original ausente ou inacessível.');
    if (!compatAvailable) errors.push('Versão compatível de áudio pendente.');

    const overallStatus =
      errors.length > 0
        ? 'Erro'
        : hasOriginal && hasMeta && hasPoster && compatAvailable && hasThumbs
        ? 'Pronto'
        : 'Parcialmente disponível';

    const fileSize =
      (regEntry && (regEntry.size || (regEntry.driveMeta && regEntry.driveMeta.size))) || m.size || 0;

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
      fileSizeMB: fileSize ? Number((fileSize / 1048576).toFixed(1)) : 0,
      metadataLoaded: hasMeta,
      matchScore: m.matchScore || 0.98,
      needsReview: Boolean(m.needsReview),
      posterFound: hasPoster,
      posterSource: m.posterSource || 'tmdb_pt_br',
      posterUrl: m.poster,
      posterFallbackUrl: m.posterFallbackUrl || `/media_cache/${fileId}/poster_fallback.jpg`,
      container: (regEntry && regEntry.container) || m.container || 'mp4',
      durationSec: Math.round((regEntry && (regEntry.durationSec || regEntry.duration)) || m.duration || 0),
      videoCodec: vCodec,
      audioCodec: aCodec,
      compatibleVersionAvailable: compatAvailable,
      compatibleMode: compatMode,
      streamUrlFunctional: true,
      streamUrl: m.recommendedCustomPlayerUrl || `/api/videos/${fileId}/stream`,
      thumbnailsGenerated: hasThumbs,
      spriteUrl: `/media_cache/${fileId}/sprite.jpg`,
      vttUrl: `/api/videos/${fileId}/thumbnails.vtt`,
      lastPlaybackTest: (regEntry && regEntry.updatedAt) || driveCatalog.lastReconciledAt,
      lastSyncAt: driveCatalog.lastReconciledAt || new Date().toISOString(),
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

  res.json({
    status: 'ok',
    environment: 'nodejs_local_server',
    officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
    summary,
    movies: items
  });
});

// Diagnóstico técnico completo de Observabilidade e Performance para Administradores (FASE 10)
app.get('/api/admin/diagnostics', requireAdmin, (req, res) => {
  const mem = process.memoryUsage();
  const ttfbList = platformMetrics.recentTtfbMs.map((x) => x.ttfbMs);
  const avgTtfbMs =
    ttfbList.length > 0 ? Math.round(ttfbList.reduce((a, b) => a + b, 0) / ttfbList.length) : 0;

  res.json({
    status: 'healthy',
    correlationId: req.correlationId,
    officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
    officialFolderUrl: OFFICIAL_DRIVE_FOLDER_URL,
    catalogCount: driveCatalog.movies.length,
    removedCount: Array.isArray(driveCatalog.removedMovies) ? driveCatalog.removedMovies.length : 0,
    metrics: {
      ...platformMetrics,
      avgTtfbMs,
      metaCacheSize: driveMetaCache.size,
      probeCacheSize: codecProbeCache.size,
      registryCachedFiles: Object.keys((mediaRegistry && mediaRegistry.files) || {}).length,
      mediaQueueLength: mediaJobQueue.length,
      isProcessingMediaQueue: isProcessingQueue
    },
    memoryMB: {
      rss: Math.round(mem.rss / (1024 * 1024)),
      heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
      heapTotal: Math.round(mem.heapTotal / (1024 * 1024))
    },
    recentLogs: recentObservabilityLogs.slice(0, 50)
  });
});

// ============================================================================
// FASE 4 — RECONCILIAÇÃO DE EXCLUSÕES E SINCRONIZAÇÃO INCREMENTAL GOOGLE DRIVE
// ============================================================================
async function checkDriveChangesApi() {
  const googleApiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  const googleOAuthToken = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();
  if (!googleOAuthToken && !googleApiKey) {
    return { supported: false, changes: [] };
  }

  const headers = {};
  if (googleOAuthToken) headers.Authorization = `Bearer ${googleOAuthToken}`;

  try {
    let pageToken = driveCatalog.driveChangesPageToken;
    if (!pageToken) {
      const startUrl = new URL('https://www.googleapis.com/drive/v3/changes/startPageToken');
      startUrl.searchParams.set('supportsAllDrives', 'true');
      if (googleApiKey && !googleOAuthToken) startUrl.searchParams.set('key', googleApiKey);
      const startRes = await fetch(startUrl.toString(), { headers });
      if (startRes.ok) {
        const startData = await startRes.json();
        driveCatalog.driveChangesPageToken = startData.startPageToken || null;
        saveDriveCatalog(driveCatalog);
      }
      return { supported: true, initializedToken: driveCatalog.driveChangesPageToken, changes: [] };
    }

    const changesUrl = new URL('https://www.googleapis.com/drive/v3/changes');
    changesUrl.searchParams.set('pageToken', pageToken);
    changesUrl.searchParams.set('includeRemoved', 'true');
    changesUrl.searchParams.set('supportsAllDrives', 'true');
    changesUrl.searchParams.set('includeItemsFromAllDrives', 'true');
    changesUrl.searchParams.set('fields', 'newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,trashed,parents))');
    if (googleApiKey && !googleOAuthToken) changesUrl.searchParams.set('key', googleApiKey);

    const res = await fetch(changesUrl.toString(), { headers });
    if (!res.ok) {
      return { supported: true, temporaryError: res.status >= 500 || res.status === 429, changes: [] };
    }
    const data = await res.json();
    if (data.newStartPageToken) {
      driveCatalog.driveChangesPageToken = data.newStartPageToken;
    }
    return { supported: true, changes: data.changes || [] };
  } catch (err) {
    return { supported: true, temporaryError: true, error: err.message, changes: [] };
  }
}

async function reconcileDriveCatalog(options = {}) {
  const { simulateTemporaryFailure = false, checkIndividualFiles = true } = options;

  // Proteção contra falha temporária da API (Teste 6): nunca apaga o catálogo se a API do Drive estiver fora do ar (5xx/timeout)
  if (simulateTemporaryFailure) {
    logStructured('DRIVE_SYNC', 'simulated_temporary_failure', { status: 503 });
    return {
      success: false,
      temporaryFailure: true,
      abortedOnError: true,
      status: 503,
      message: 'Falha temporária ao comunicar com o Google Drive. Nenhum filme foi removido por segurança.',
      checkedCount: 0,
      removedCount: 0,
      removedMovies: [],
      totalMovies: driveCatalog.movies.length
    };
  }

  // Primeiro sincroniza novos arquivos e renomeações da pasta oficial 185iFV7I5x107sxJDTVbSxA9F0pY3GtTr
  let syncAddedCount = 0;
  let syncUpdatedCount = 0;
  const folderSyncRes = await syncDriveFolderById(OFFICIAL_DRIVE_FOLDER_ID, {
    folderUrl: OFFICIAL_DRIVE_FOLDER_URL,
    defaultCategory: 'Auto',
    removeMissingFromFolder: true,
    trigger: 'reconcile'
  });
  if (folderSyncRes && folderSyncRes.ok) {
    syncAddedCount = folderSyncRes.addedCount || 0;
    syncUpdatedCount = folderSyncRes.updatedCount || 0;
  }

  const removedEntries = [...((folderSyncRes && folderSyncRes.removedMovies) || [])];
  let temporaryErrors = 0;
  let checkedCount = 0;

  // 1. Verifica Google Drive Changes API v3 (se credenciais OAuth/API Key estiverem ativas)
  const changesInfo = await checkDriveChangesApi();
  const removedByChangesSet = new Set();
  if (changesInfo.changes && changesInfo.changes.length > 0) {
    for (const ch of changesInfo.changes) {
      if (ch.removed || (ch.file && ch.file.trashed)) {
        removedByChangesSet.add(ch.fileId);
      }
    }
  }

  // 2. Reconcilia pastas monitoradas (ex: 185iFV7I5x107sxJDTVbSxA9F0pY3GtTr)
  const folderFilesMap = new Map(); // folderId -> Set(fileIds)
  for (const folder of driveCatalog.folders || []) {
    if (!folder || !folder.folderId) continue;
    const fRes = await fetchDriveFolderFiles(folder.folderId);
    if (fRes.temporaryError) {
      temporaryErrors += 1;
      continue;
    }
    if (fRes.ok && Array.isArray(fRes.files) && fRes.files.length > 0) {
      folderFilesMap.set(folder.folderId, new Set(fRes.files.map((x) => x.fileId)));
    }
  }

  // 3. Verifica cada filme do catálogo
  const survivingMovies = [];
  for (const movie of driveCatalog.movies) {
    if (!movie.driveFileId) {
      survivingMovies.push(movie);
      continue;
    }
    checkedCount += 1;

    // 3a. Confirmado como removido/lixeira pela Changes API
    if (removedByChangesSet.has(movie.driveFileId)) {
      removedEntries.push({
        id: movie.id,
        driveFileId: movie.driveFileId,
        title: movie.title,
        reason: 'drive_changes_api_removed_or_trashed',
        removedAt: new Date().toISOString()
      });
      cleanupRemovedMovieMediaCache(movie.driveFileId);
      continue;
    }

    // 3b. Se a pasta à qual o filme pertence foi escaneada com sucesso e o arquivo não está mais lá, verifica o arquivo diretamente
    const targetFolderId =
      movie.folderId || (driveCatalog.folders && driveCatalog.folders.length === 1 ? driveCatalog.folders[0].folderId : null);
    const folderSet = targetFolderId ? folderFilesMap.get(targetFolderId) : null;
    const missingFromSyncedFolder = folderSet ? !folderSet.has(movie.driveFileId) : false;

    if (checkIndividualFiles || missingFromSyncedFolder) {
      const meta = await getDriveFileMetadata(movie.driveFileId, { bypassCache: true });

      if (meta.errorStatus === 404 || meta.trashed === true) {
        removedEntries.push({
          id: movie.id,
          driveFileId: movie.driveFileId,
          title: movie.title,
          reason: meta.trashed ? 'file_in_trash' : 'file_deleted_404',
          removedAt: new Date().toISOString()
        });
        cleanupRemovedMovieMediaCache(movie.driveFileId);
        continue;
      }

      if (meta.errorStatus === 403 && missingFromSyncedFolder) {
        removedEntries.push({
          id: movie.id,
          driveFileId: movie.driveFileId,
          title: movie.title,
          reason: 'permission_revoked_and_removed_from_folder',
          removedAt: new Date().toISOString()
        });
        cleanupRemovedMovieMediaCache(movie.driveFileId);
        continue;
      }

      if (missingFromSyncedFolder && movie.folderId) {
        removedEntries.push({
          id: movie.id,
          driveFileId: movie.driveFileId,
          title: movie.title,
          reason: 'moved_out_of_synced_folder',
          removedAt: new Date().toISOString()
        });
        cleanupRemovedMovieMediaCache(movie.driveFileId);
        continue;
      }

      if (meta.errorStatus && meta.errorStatus >= 500) {
        temporaryErrors += 1;
        // Em erro temporário 5xx/502, mantém o filme no catálogo!
      } else if (!meta.errorStatus && meta.name && !movie.fileName) {
        movie.fileName = meta.name;
      }
    }

    survivingMovies.push(movie);
  }

  driveCatalog.movies = survivingMovies;
  driveCatalog.lastReconciledAt = new Date().toISOString();
  if (removedEntries.length > 0) {
    if (!Array.isArray(driveCatalog.removedMovies)) driveCatalog.removedMovies = [];
    driveCatalog.removedMovies.unshift(...removedEntries);
  }
  saveDriveCatalog(driveCatalog);

  if (removedEntries.length > 0 || syncAddedCount > 0 || syncUpdatedCount > 0) {
    io.emit('catalog_synced', {
      movies: driveCatalog.movies.map(enrichMovieWithPlaybackInfo),
      removedIds: removedEntries.map((r) => r.id)
    });
  }

  return {
    success: true,
    checkedCount,
    addedCount: syncAddedCount,
    updatedCount: syncUpdatedCount,
    removedCount: removedEntries.length,
    removedMovies: removedEntries,
    temporaryErrors,
    totalMovies: driveCatalog.movies.length,
    lastReconciledAt: driveCatalog.lastReconciledAt,
    movies: driveCatalog.movies.map(enrichMovieWithPlaybackInfo)
  };
}

app.post('/api/drive/reconcile', requireAdmin, async (req, res) => {
  try {
    const simulateTemporaryFailure = Boolean(req.body && req.body.simulateTemporaryFailure);
    const result = await reconcileDriveCatalog({
      simulateTemporaryFailure,
      checkIndividualFiles: true
    });
    if (result.temporaryFailure) {
      return res.status(503).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao reconciliar catálogo com o Google Drive: ' + err.message });
  }
});

// ============================================================================
// INTEGRAÇÃO GOOGLE DRIVE API v3 + STREAMING HTTP 206 + DIAGNÓSTICO DE CODECS
// ============================================================================
const driveMetaCache = new Map();
const codecProbeCache = new Map();
const META_CACHE_TTL_MS = 30 * 60 * 1000;

function isValidDriveFileId(fileId) {
  return /^[a-zA-Z0-9_-]{20,60}$/.test(String(fileId || '').trim());
}

function isFileAuthorizedInCatalog(fileId) {
  if (!isValidDriveFileId(fileId)) return false;
  if (driveCatalog && Array.isArray(driveCatalog.movies)) {
    if (driveCatalog.movies.some((m) => m.driveFileId === fileId && !m.unavailable && !m.trashed)) {
      return true;
    }
  }
  return false;
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

async function getDriveFileMetadata(fileId, options = {}) {
  const { bypassCache = false } = options;
  if (!bypassCache) {
    const cached = driveMetaCache.get(fileId);
    if (cached && Date.now() - cached.cachedAt < META_CACHE_TTL_MS) {
      platformMetrics.metaCacheHits += 1;
      return cached.meta;
    }
    const regEntry = mediaRegistry && mediaRegistry.files && mediaRegistry.files[fileId];
    if (regEntry && regEntry.driveMeta && regEntry.driveMeta.size > 0) {
      driveMetaCache.set(fileId, { meta: regEntry.driveMeta, cachedAt: Date.now() });
      platformMetrics.metaCacheHits += 1;
      return regEntry.driveMeta;
    }
  }

  const googleApiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  const googleOAuthToken = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();

  // 1. Tenta Google Drive API v3 oficial quando credenciais estiverem configuradas no backend
  if (googleApiKey || googleOAuthToken) {
    try {
      const apiUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      apiUrl.searchParams.set('fields', 'id,name,mimeType,size,trashed,parents,capabilities(canDownload)');
      apiUrl.searchParams.set('supportsAllDrives', 'true');
      if (googleApiKey && !googleOAuthToken) {
        apiUrl.searchParams.set('key', googleApiKey);
      }

      const headers = {};
      if (googleOAuthToken) {
        headers.Authorization = `Bearer ${googleOAuthToken}`;
      }

      const apiRes = await fetch(apiUrl.toString(), { headers });
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data.trashed) {
          return { errorStatus: 404, trashed: true, error: 'Arquivo está na lixeira do Google Drive.' };
        }
        const canDownload = data.capabilities ? data.capabilities.canDownload !== false : true;
        const meta = {
          id: data.id,
          name: data.name || `${fileId}.mp4`,
          rawMimeType: data.mimeType || '',
          mimeType: inferMimeType(data.name, data.mimeType),
          size: Number(data.size || 0),
          trashed: Boolean(data.trashed),
          parents: data.parents || [],
          canDownload,
          source: 'drive_api_v3'
        };
        driveMetaCache.set(fileId, { meta, cachedAt: Date.now() });
        if (mediaRegistry && mediaRegistry.files) {
          mediaRegistry.files[fileId] = {
            ...(mediaRegistry.files[fileId] || {}),
            fileId,
            driveMeta: meta
          };
          saveMediaRegistry();
        }
        return meta;
      }
      if (apiRes.status === 404 || apiRes.status === 403 || apiRes.status === 401) {
        return { errorStatus: apiRes.status, error: 'Arquivo não encontrado ou sem permissão na Google Drive API v3.' };
      }
    } catch (err) {
      console.warn(`[Drive API v3] Falha ao consultar metadados de ${fileId}: ${err.message}`);
    }
  }

  // 2. Fallback seguro via HEAD com Range delimitado
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
      return { errorStatus: 403, error: 'Arquivo não está público ou foi removido do Google Drive.' };
    }

    const sizeMatch = cr.match(/\/(\d+)/);
    const totalSize = sizeMatch ? Number(sizeMatch[1]) : 0;
    const filenameMatch = cd.match(/filename="([^"]+)"/i);
    const fileName = filenameMatch ? filenameMatch[1] : `${fileId}.mp4`;

    const meta = {
      id: fileId,
      name: fileName,
      rawMimeType: ct,
      mimeType: inferMimeType(fileName, ct),
      size: totalSize,
      trashed: false,
      canDownload: totalSize > 0,
      source: 'drive_public_head'
    };
    driveMetaCache.set(fileId, { meta, cachedAt: Date.now() });
    if (mediaRegistry && mediaRegistry.files && totalSize > 0) {
      mediaRegistry.files[fileId] = {
        ...(mediaRegistry.files[fileId] || {}),
        fileId,
        driveMeta: meta
      };
      saveMediaRegistry();
    }
    return meta;
  } catch (err) {
    return { errorStatus: 502, error: 'Falha ao consultar arquivo no Google Drive: ' + err.message };
  }
}

// ============================================================================
// FASE 1 & FASE 3 — ANÁLISE REAL FFPROBE, REMUX/TRANSCODE AAC-LC (FILA E CACHE
// HLS/MP4 PARA O PLAYER PERSONALIZADO) & GERAÇÃO DE THUMBNAILS DE CENAS (FFMPEG)
// ============================================================================
const MEDIA_REGISTRY_FILE = path.join(PREPARED_MEDIA_DIR, 'registry.json');
const PUBLIC_MEDIA_REGISTRY_FILE = path.join(PUBLIC_MEDIA_CACHE_DIR, 'registry.json');
let mediaRegistry = { files: {} };
try {
  fs.mkdirSync(PREPARED_MEDIA_DIR, { recursive: true });
  if (fs.existsSync(MEDIA_REGISTRY_FILE)) {
    mediaRegistry = JSON.parse(fs.readFileSync(MEDIA_REGISTRY_FILE, 'utf8'));
    if (!mediaRegistry || typeof mediaRegistry.files !== 'object') {
      mediaRegistry = { files: {} };
    }
  }
  if (fs.existsSync(PUBLIC_MEDIA_REGISTRY_FILE)) {
    const pubReg = JSON.parse(fs.readFileSync(PUBLIC_MEDIA_REGISTRY_FILE, 'utf8'));
    if (pubReg && typeof pubReg.files === 'object') {
      for (const [fId, fEntry] of Object.entries(pubReg.files)) {
        mediaRegistry.files[fId] = {
          ...(mediaRegistry.files[fId] || {}),
          ...fEntry
        };
      }
    }
  }
} catch (_) {
  mediaRegistry = { files: {} };
}

function saveMediaRegistry() {
  try {
    fs.mkdirSync(PREPARED_MEDIA_DIR, { recursive: true });
    fs.writeFileSync(MEDIA_REGISTRY_FILE, JSON.stringify(mediaRegistry, null, 2));
  } catch (_) {}
}

function getFileMediaDir(fileId) {
  const dir = path.join(PREPARED_MEDIA_DIR, fileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getPreparedMp4Path(fileId, audioTrack = 0) {
  if (!isValidDriveFileId(fileId)) return null;
  const trackIdx = Math.max(0, parseInt(audioTrack, 10) || 0);
  const candidates = [
    path.join(PREPARED_MEDIA_DIR, fileId, `compatible_a${trackIdx}.mp4`),
    trackIdx === 0 ? path.join(PREPARED_MEDIA_DIR, `${fileId}.mp4`) : null,
    trackIdx === 0 ? path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'compat.mp4') : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 65536) {
        return candidate;
      }
    } catch (_) {}
  }
  return null;
}

let cachedFfmpegAvailable = null;
let cachedFfprobeAvailable = null;

function checkFfmpegAvailable() {
  if (typeof cachedFfmpegAvailable === 'boolean') {
    return Promise.resolve(cachedFfmpegAvailable);
  }
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, ['-version']);
    proc.on('error', () => {
      cachedFfmpegAvailable = false;
      resolve(false);
    });
    proc.on('close', (code) => {
      cachedFfmpegAvailable = code === 0;
      resolve(cachedFfmpegAvailable);
    });
  });
}

function checkFfprobeAvailable() {
  if (typeof cachedFfprobeAvailable === 'boolean') {
    return Promise.resolve(cachedFfprobeAvailable);
  }
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE_BIN, ['-version']);
    proc.on('error', () => {
      cachedFfprobeAvailable = false;
      resolve(false);
    });
    proc.on('close', (code) => {
      cachedFfprobeAvailable = code === 0;
      resolve(cachedFfprobeAvailable);
    });
  });
}

// Hidrata os caches em memória a partir do registry.json no boot para resposta < 1ms
function hydrateCachesFromMediaRegistry() {
  if (!mediaRegistry || !mediaRegistry.files) return;
  for (const [fileId, entry] of Object.entries(mediaRegistry.files)) {
    if (!entry || !isValidDriveFileId(fileId)) continue;
    const size = (entry.driveMeta && entry.driveMeta.size) || entry.size || 0;
    if (size > 0) {
      const meta = entry.driveMeta || {
        id: fileId,
        name: entry.fileName || `${fileId}.${entry.container || 'mp4'}`,
        mimeType: inferMimeType(entry.fileName, null),
        size,
        trashed: false,
        canDownload: true,
        source: 'media_registry_cache'
      };
      driveMetaCache.set(fileId, { meta, cachedAt: Date.now() });
    }
    if (Array.isArray(entry.videoCodecs) && entry.videoCodecs.length > 0) {
      const preparedPath = getPreparedMp4Path(fileId, 0);
      const audioTracks = Array.isArray(entry.audioTracks) ? entry.audioTracks : [];
      const primaryTrackCompat =
        entry.container !== 'avi' &&
        (audioTracks.length > 0
          ? Boolean(audioTracks[0].browserSupported)
          : (entry.audioCodecs || []).some((c) => ['AAC', 'Opus', 'Vorbis', 'MP3'].includes(c)));
      const hasSidecarHls =
        Boolean(entry.sidecarAudioHlsUrl) ||
        fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'audio_0', 'index.m3u8'));
      const hasSidecar =
        hasSidecarHls ||
        Boolean(entry.hasSidecarAudio0) ||
        fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'audio_0.m4a'));
      const sidecarHlsUrl = hasSidecarHls ? `/media_cache/${fileId}/audio_0/index.m3u8` : null;
      const isEbmlDual = Boolean(entry.isEbmlRemappableDual);
      const hasCompatMp4 =
        Boolean(entry.hasCompatMp4) ||
        fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'compat.mp4'));

      let recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream`;
      if (hasCompatMp4) {
        recommendedCustomPlayerUrl = `/media_cache/${fileId}/compat.mp4`;
      } else if (preparedPath) {
        recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream?compat=1&audioTrack=0`;
      }

      codecProbeCache.set(fileId, {
        fileId,
        fileName: entry.fileName || `${fileId}.mp4`,
        size,
        duration: Number(entry.durationSec) || 0,
        container: entry.container || 'mp4',
        videoCodecs: entry.videoCodecs || ['H.264 (AVC)'],
        audioCodecs: entry.audioCodecs || ['AAC'],
        audioTrackCount: audioTracks.length || 1,
        isDualAudio: audioTracks.length > 1,
        languages: audioTracks.map((t) => ({ code: t.language, label: t.languageLabel })),
        audioTracks,
        subtitleTracks: Array.isArray(entry.subtitleTracks) ? entry.subtitleTracks : [],
        fastStartMoov: true,
        ffmpegAvailable: true,
        browserVideoSupported: entry.container !== 'avi' && !(entry.videoCodecs || []).includes('H.265 (HEVC)'),
        browserAudioSupported: Boolean(preparedPath) || primaryTrackCompat || isEbmlDual || hasSidecar || hasCompatMp4,
        primaryTrackCompat,
        isEbmlRemappableDual: isEbmlDual,
        hasSidecarAudio0: hasSidecar,
        sidecarAudioHlsUrl: sidecarHlsUrl,
        sidecarAudioUrl: sidecarHlsUrl
          ? sidecarHlsUrl
          : hasSidecar
          ? `/media_cache/${fileId}/audio_0.m4a`
          : `/api/videos/${fileId}/audio-stream.m4a?track=0`,
        sidecarAudioDurationSec: Number(entry.sidecarAudioDurationSec || 0),
        sidecarAudioComplete: hasSidecarHls || entry.sidecarAudioComplete !== false,
        hasCompatMp4,
        compatMp4Url: hasCompatMp4 ? `/media_cache/${fileId}/compat.mp4` : null,
        requiresSidecarAudio: !primaryTrackCompat && entry.container !== 'avi' && !preparedPath,
        hasPreparedCompatibleStream: Boolean(preparedPath || hasCompatMp4),
        hasPreparedCompatibleAudio: Boolean(preparedPath || hasSidecar || hasCompatMp4),
        requiresAudioFallbackOrRemux: Boolean(hasCompatMp4),
        recommendedCustomPlayerUrl,
        diagnosticReason: preparedPath || hasCompatMp4
          ? 'Versão MP4 (H.264 + AAC-LC Estéreo) pronta e armazenada no servidor.'
          : primaryTrackCompat
          ? `Áudio ${(entry.audioCodecs || []).join(' / ')} compatível nativamente com o Player Personalizado.`
          : isEbmlDual
          ? `Áudio Dual (${(entry.audioCodecs || []).join(' + ')}) com faixa AAC-LC Estéreo integrada e remapeada automaticamente no Player Personalizado.`
          : `Áudio original ${(entry.audioCodecs || []).join(', ')} convertido automaticamente para AAC-LC Estéreo sincronizado no Player Personalizado.`
      });
    }
  }
}
hydrateCachesFromMediaRegistry();

// Cache de extremidades do arquivo (primeiros 1MB + últimos 512KB) para que o FFprobe e o FFmpeg
// leiam o cabeçalho EBML/MP4 e o índice Cues/moov em < 1ms sem múltiplas viagens ao Google Drive!
const headTailFetchLocks = new Map();

async function ensureHeadTailCache(fileId, totalSize) {
  if (!totalSize || totalSize < 1024 * 1024) return null;
  const mediaDir = getFileMediaDir(fileId);
  const headPath = path.join(mediaDir, 'head_1mb.bin');
  const tailPath = path.join(mediaDir, 'tail_512kb.bin');
  const HEAD_SIZE = Math.min(1024 * 1024, totalSize);
  const TAIL_SIZE = Math.min(512 * 1024, totalSize);
  const tailStart = Math.max(0, totalSize - TAIL_SIZE);

  if (fs.existsSync(headPath) && fs.existsSync(tailPath)) {
    try {
      if (fs.statSync(headPath).size === HEAD_SIZE && fs.statSync(tailPath).size === TAIL_SIZE) {
        return { headPath, tailPath, headSize: HEAD_SIZE, tailStart, tailSize: TAIL_SIZE };
      }
    } catch (_) {}
  }

  if (headTailFetchLocks.has(fileId)) {
    return headTailFetchLocks.get(fileId);
  }

  const promise = (async () => {
    try {
      const downloadUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
        fileId
      )}&export=download&confirm=t`;
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

      const [headRes, tailRes] = await Promise.all([
        !fs.existsSync(headPath)
          ? fetch(downloadUrl, { headers: { 'User-Agent': ua, Range: `bytes=0-${HEAD_SIZE - 1}` }, redirect: 'follow' })
          : null,
        !fs.existsSync(tailPath)
          ? fetch(downloadUrl, {
              headers: { 'User-Agent': ua, Range: `bytes=${tailStart}-${totalSize - 1}` },
              redirect: 'follow'
            })
          : null
      ]);

      if (headRes && (headRes.ok || headRes.status === 206)) {
        const buf = Buffer.from(await headRes.arrayBuffer());
        if (buf.length === HEAD_SIZE) fs.writeFileSync(headPath, buf);
      }
      if (tailRes && (tailRes.ok || tailRes.status === 206)) {
        const buf = Buffer.from(await tailRes.arrayBuffer());
        if (buf.length === TAIL_SIZE) fs.writeFileSync(tailPath, buf);
      }

      if (fs.existsSync(headPath) && fs.existsSync(tailPath)) {
        return { headPath, tailPath, headSize: HEAD_SIZE, tailStart, tailSize: TAIL_SIZE };
      }
    } catch (_) {}
    return null;
  })().finally(() => {
    headTailFetchLocks.delete(fileId);
  });

  headTailFetchLocks.set(fileId, promise);
  return promise;
}

function normalizeLanguageTag(rawLang, titleHint = '', idx = 0) {
  const s = `${rawLang || ''} ${titleHint || ''}`.toLowerCase();
  if (/\b(por|pt|pt-br|portugues|português|dublado|br)\b/.test(s)) {
    return { code: 'pt-BR', label: 'Português (Brasil)', flag: '🇧🇷' };
  }
  if (/\b(eng|en|english|ingles|inglês|original)\b/.test(s)) {
    return { code: 'en', label: 'Inglês (Original)', flag: '🇺🇸' };
  }
  if (/\b(spa|es|espanol|espanhol)\b/.test(s)) {
    return { code: 'es', label: 'Espanhol', flag: '🇪🇸' };
  }
  if (/\b(jpn|ja|japones|japonês)\b/.test(s)) {
    return { code: 'ja', label: 'Japonês', flag: '🇯🇵' };
  }
  return { code: rawLang || `track_${idx + 1}`, label: titleHint || `Faixa de Áudio ${idx + 1}`, flag: '🎧' };
}

function formatCodecDisplayName(codecName) {
  const c = String(codecName || '').toLowerCase();
  if (c === 'aac') return 'AAC';
  if (c === 'ac3') return 'AC-3 (Dolby Digital 5.1)';
  if (c === 'eac3') return 'E-AC-3 (Dolby Digital Plus)';
  if (c === 'dts' || c === 'dca') return 'DTS';
  if (c === 'truehd') return 'Dolby TrueHD';
  if (c === 'opus') return 'Opus';
  if (c === 'vorbis') return 'Vorbis';
  if (c === 'mp3') return 'MP3';
  if (c === 'mp2') return 'MP2';
  if (c === 'flac') return 'FLAC';
  if (c === 'h264' || c === 'avc1') return 'H.264 (AVC)';
  if (c === 'hevc' || c === 'h265') return 'H.265 (HEVC)';
  if (c === 'vp9') return 'VP9';
  if (c === 'vp8') return 'VP8';
  if (c === 'av1') return 'AV1';
  if (c === 'mpeg4') return 'MPEG-4 Visual (AVI/Xvid)';
  return codecName ? String(codecName).toUpperCase() : 'Desconhecido';
}

const ffprobeLocks = new Map();

async function runFfprobeOnDriveFile(fileId, meta) {
  const mediaDir = getFileMediaDir(fileId);
  const probeCachePath = path.join(mediaDir, 'ffprobe.json');
  if (fs.existsSync(probeCachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(probeCachePath, 'utf8'));
      if (cached && Array.isArray(cached.streams) && cached.streams.length > 0) {
        return cached;
      }
    } catch (_) {}
  }

  if (ffprobeLocks.has(fileId)) {
    return ffprobeLocks.get(fileId);
  }

  const promise = (async () => {
    const hasFfprobe = await checkFfprobeAvailable();
    if (!hasFfprobe) return null;

    const headTail = await ensureHeadTailCache(fileId, meta.size);
    const probeEntries =
      'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,codec_long_name,profile,channels,channel_layout,sample_rate,width,height:stream_tags=language,title';

    const runProbeTarget = (target, timeoutMs = 12000) =>
      new Promise((resolve) => {
        execFile(
          FFPROBE_BIN,
          [
            '-v',
            'error',
            '-probesize',
            '1000000',
            '-analyzeduration',
            '1500000',
            '-show_entries',
            probeEntries,
            '-of',
            'json',
            target
          ],
          { timeout: timeoutMs },
          (err, stdout) => {
            if (err || !stdout) return resolve(null);
            try {
              const parsed = JSON.parse(stdout);
              if (parsed && Array.isArray(parsed.streams) && parsed.streams.length > 0) {
                return resolve(parsed);
              }
            } catch (_) {}
            resolve(null);
          }
        );
      });

    // 1. Tenta primeiro no cache local de cabeçalho (head_1mb.bin) em ~15ms
    if (headTail && headTail.headPath && fs.existsSync(headTail.headPath)) {
      const fastParsed = await runProbeTarget(headTail.headPath, 6000);
      if (fastParsed && Array.isArray(fastParsed.streams) && fastParsed.streams.length > 0) {
        if (fastParsed.format && meta.size) {
          fastParsed.format.size = String(meta.size);
        }
        try {
          fs.writeFileSync(probeCachePath, JSON.stringify(fastParsed, null, 2));
        } catch (_) {}
        return fastParsed;
      }
    }

    // 2. Caso o átomo moov esteja no final do MP4, consulta via proxy Range local (que usa tail_512kb.bin)
    const localStreamUrl = `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1`;
    const fullParsed = await runProbeTarget(localStreamUrl, 15000);
    if (fullParsed && Array.isArray(fullParsed.streams) && fullParsed.streams.length > 0) {
      try {
        fs.writeFileSync(probeCachePath, JSON.stringify(fullParsed, null, 2));
      } catch (_) {}
      return fullParsed;
    }
    return null;
  })().finally(() => {
    ffprobeLocks.delete(fileId);
  });

  ffprobeLocks.set(fileId, promise);
  return promise;
}

async function probeMediaCodecs(fileId) {
  if (codecProbeCache.has(fileId)) {
    const cached = codecProbeCache.get(fileId);
    // Atualiza status dinâmico de preparação
    const preparedMp4 = getPreparedMp4Path(fileId, 0);
    cached.hasPreparedCompatibleStream = Boolean(preparedMp4);
    cached.hasPreparedCompatibleAudio = Boolean(preparedMp4);
    return cached;
  }

  const meta = await getDriveFileMetadata(fileId);
  if (meta.errorStatus) {
    return { errorStatus: meta.errorStatus, error: meta.error };
  }

  const preparedPath = getPreparedMp4Path(fileId, 0);
  const fileName = meta.name || `${fileId}.mp4`;
  const lowerName = fileName.toLowerCase();
  const hasFfmpeg = await checkFfmpegAvailable();

  // 1. Tenta análise real e exata com FFprobe (FASE 1)
  const ffprobeData = await runFfprobeOnDriveFile(fileId, meta);

  let container = 'mp4';
  if (lowerName.endsWith('.mkv')) container = 'mkv';
  else if (lowerName.endsWith('.webm')) container = 'webm';
  else if (lowerName.endsWith('.avi')) container = 'avi';

  let durationSec = 0;
  let videoCodecs = [];
  let audioCodecs = [];
  let audioTracks = [];
  let subtitleTracks = [];
  let detectedLanguages = [];
  let fastStartMoov = null;

  if (ffprobeData && Array.isArray(ffprobeData.streams)) {
    const fmtName = String((ffprobeData.format && ffprobeData.format.format_name) || '').toLowerCase();
    if (fmtName.includes('matroska')) {
      container = lowerName.endsWith('.webm') ? 'webm' : 'mkv';
    } else if (fmtName.includes('avi')) {
      container = 'avi';
    } else if (fmtName.includes('mp4') || fmtName.includes('mov')) {
      container = 'mp4';
    }

    durationSec = Number(ffprobeData.format && ffprobeData.format.duration) || 0;

    const vStreams = ffprobeData.streams.filter(
      (s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png'
    );
    const aStreams = ffprobeData.streams.filter((s) => s.codec_type === 'audio');
    const sStreams = ffprobeData.streams.filter((s) => s.codec_type === 'subtitle');

    for (const vs of vStreams) {
      const disp = formatCodecDisplayName(vs.codec_name);
      if (!videoCodecs.includes(disp)) videoCodecs.push(disp);
    }

    aStreams.forEach((as, idx) => {
      const codecDisp = formatCodecDisplayName(as.codec_name);
      if (!audioCodecs.includes(codecDisp)) audioCodecs.push(codecDisp);

      const rawLang = (as.tags && as.tags.language) || '';
      const rawTitle = (as.tags && as.tags.title) || '';
      const normLang = normalizeLanguageTag(rawLang, rawTitle || (idx === 0 ? 'pt-BR' : 'en'), idx);
      if (!detectedLanguages.some((l) => l.code === normLang.code)) {
        detectedLanguages.push({ code: normLang.code, label: normLang.label });
      }

      const isBrowserSupportedCodec = ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(
        String(as.codec_name || '').toLowerCase()
      );
      const trackPreparedMp4 = getPreparedMp4Path(fileId, idx);

      audioTracks.push({
        trackIndex: idx,
        streamIndex: as.index,
        codec: String(as.codec_name || '').toLowerCase(),
        codecLabel: codecDisp,
        channels: Number(as.channels) || 2,
        channelLayout: as.channel_layout || (Number(as.channels) === 6 ? '5.1' : 'stereo'),
        sampleRate: Number(as.sample_rate) || 48000,
        language: normLang.code,
        languageLabel: normLang.label,
        title: rawTitle || `${normLang.label} (${codecDisp})`,
        label: `${normLang.flag} ${normLang.label} • ${
          isBrowserSupportedCodec && container !== 'avi' ? codecDisp : `${codecDisp} → AAC-LC Estéreo`
        }`,
        browserSupported: isBrowserSupportedCodec && container !== 'avi',
        streamUrl:
          trackPreparedMp4
            ? `/api/videos/${fileId}/stream?compat=1&audioTrack=${idx}`
            : isBrowserSupportedCodec && container !== 'avi' && idx === 0
            ? `/api/videos/${fileId}/stream`
            : `/api/videos/${fileId}/hls/${idx}/playlist.m3u8`
      });
    });

    sStreams.forEach((ss, idx) => {
      const sCodec = String(ss.codec_name || '').toLowerCase();
      if (['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(sCodec)) {
        const rawLang = (ss.tags && ss.tags.language) || '';
        const rawTitle = (ss.tags && ss.tags.title) || '';
        const normLang = normalizeLanguageTag(rawLang, rawTitle, idx);
        subtitleTracks.push({
          subIndex: idx,
          streamIndex: ss.index,
          codec: sCodec,
          language: normLang.code,
          label: rawTitle || `${normLang.flag} ${normLang.label}`,
          vttUrl: `/api/videos/${fileId}/subtitles/${idx}.vtt`
        });
      }
    });
  } else {
    // 2. Fallback por inspeção binária direta caso ffprobe não esteja disponível no ambiente
    let headerBuf = Buffer.alloc(0);
    try {
      const headCache = await ensureHeadTailCache(fileId, meta.size);
      if (headCache && fs.existsSync(headCache.headPath)) {
        headerBuf = fs.readFileSync(headCache.headPath).subarray(0, 262144);
      } else {
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
          headerBuf = Buffer.from(await r.arrayBuffer());
        }
      }
    } catch (_) {}

    const ascii = headerBuf.toString('latin1');
    if (
      headerBuf.length >= 4 &&
      headerBuf[0] === 0x1a &&
      headerBuf[1] === 0x45 &&
      headerBuf[2] === 0xdf &&
      headerBuf[3] === 0xa3
    ) {
      container = ascii.toLowerCase().includes('webm') || lowerName.endsWith('.webm') ? 'webm' : 'mkv';
    } else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') {
      container = 'avi';
    } else if (ascii.slice(4, 8) === 'ftyp' || lowerName.endsWith('.mp4') || lowerName.endsWith('.m4v')) {
      container = 'mp4';
    }

    if (
      ascii.includes('V_MPEG4/ISO/AVC') ||
      ascii.includes('avc1') ||
      ascii.includes('avc3') ||
      /\bh\.?264|x264\b/i.test(fileName)
    ) {
      videoCodecs.push('H.264 (AVC)');
    }
    if (ascii.includes('V_VP9') || ascii.includes('vp09')) videoCodecs.push('VP9');
    if (container === 'avi' && videoCodecs.length === 0) videoCodecs.push('MPEG-4 Visual (AVI/Xvid)');
    if (videoCodecs.length === 0) videoCodecs.push('H.264 (AVC)');

    const countOccurrences = (str, sub) => {
      if (!sub) return 0;
      let count = 0;
      let pos = 0;
      while ((pos = str.indexOf(sub, pos)) !== -1) {
        count += 1;
        pos += sub.length;
      }
      return count;
    };

    const aacCount = countOccurrences(ascii, 'A_AAC') + countOccurrences(ascii, 'mp4a');
    const ac3Count = countOccurrences(ascii, 'A_AC3') + countOccurrences(ascii, 'ac-3');
    const eac3Count = countOccurrences(ascii, 'A_EAC3') + countOccurrences(ascii, 'ec-3');
    const dtsCount = countOccurrences(ascii, 'A_DTS') + countOccurrences(ascii, 'dtsc');
    const opusCount = countOccurrences(ascii, 'A_OPUS') + countOccurrences(ascii, 'Opus');
    const vorbisCount = countOccurrences(ascii, 'A_VORBIS');
    const mp3Count = countOccurrences(ascii, 'A_MPEG/L3') + countOccurrences(ascii, '.mp3');

    if (aacCount > 0) audioCodecs.push('AAC');
    if (ac3Count > 0 || /\bac-?3\b/i.test(fileName)) audioCodecs.push('AC-3 (Dolby Digital 5.1)');
    if (eac3Count > 0 || /\be-?ac-?3|ddp\b/i.test(fileName)) audioCodecs.push('E-AC-3 (Dolby Digital Plus)');
    if (dtsCount > 0 || /\bdts\b/i.test(fileName)) audioCodecs.push('DTS');
    if (opusCount > 0) audioCodecs.push('Opus');
    if (vorbisCount > 0) audioCodecs.push('Vorbis');
    if (mp3Count > 0) audioCodecs.push('MP3');
    if (audioCodecs.length === 0) {
      if (container === 'webm') audioCodecs.push('Opus/Vorbis');
      else if (container === 'mp4') audioCodecs.push('AAC');
      else if (container === 'avi') audioCodecs.push('MP3/AC-3 (AVI)');
    }

    const isDualByName = /\b(dual|dublado|multi)\b/i.test(fileName);
    if (ascii.includes('por') || /\b(pt-?br|dublado|dual|portugues)\b/i.test(fileName)) {
      detectedLanguages.push({ code: 'pt-BR', label: 'Português (Brasil)' });
    }
    if (ascii.includes('eng') || isDualByName) {
      detectedLanguages.push({ code: 'en', label: 'Inglês (Original)' });
    }
    if (detectedLanguages.length === 0) {
      detectedLanguages.push({ code: 'pt-BR', label: 'Português (Brasil)' });
    }

    detectedLanguages.forEach((lang, idx) => {
      const primaryCodec = audioCodecs[0] || 'AAC';
      const isCompat = ['AAC', 'Opus', 'Vorbis', 'Opus/Vorbis', 'MP3'].includes(primaryCodec) && container !== 'avi';
      audioTracks.push({
        trackIndex: idx,
        streamIndex: idx + 1,
        codec: primaryCodec.toLowerCase(),
        codecLabel: primaryCodec,
        channels: primaryCodec.includes('5.1') ? 6 : 2,
        channelLayout: primaryCodec.includes('5.1') ? '5.1' : 'stereo',
        sampleRate: 48000,
        language: lang.code,
        languageLabel: lang.label,
        title: `${lang.label} (${primaryCodec})`,
        label: `${lang.code === 'pt-BR' ? '🇧🇷' : '🇺🇸'} ${lang.label} • ${primaryCodec}`,
        browserSupported: isCompat,
        streamUrl: isCompat ? `/api/videos/${fileId}/stream` : `/api/videos/${fileId}/hls/${idx}/playlist.m3u8`
      });
    });

    if (container === 'mp4') {
      const moovIdx = ascii.indexOf('moov');
      const mdatIdx = ascii.indexOf('mdat');
      fastStartMoov = moovIdx !== -1 && (mdatIdx === -1 || moovIdx < mdatIdx);
    }
  }

  const hasBrowserCompatibleAudioTrack =
    container !== 'avi' &&
    audioTracks.length > 0 &&
    audioTracks.every((t) => t.browserSupported);

  const primaryTrackCompat =
    container !== 'avi' &&
    (audioTracks.length > 0
      ? audioTracks[0].browserSupported
      : audioCodecs.includes('AAC') ||
        audioCodecs.includes('Opus') ||
        audioCodecs.includes('Vorbis') ||
        audioCodecs.includes('MP3'));

  const hasSidecarAudio0 = fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'audio_0.m4a'));
  const hasCompatMp4 = fs.existsSync(path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'compat.mp4'));
  const isEbmlRemappableDual =
    container === 'mkv' &&
    audioTracks.length > 1 &&
    !audioTracks[0].browserSupported &&
    audioTracks.slice(1).some((t) => t.browserSupported);

  // Registra no índice persistente prepared_media/registry.json
  const existingEntry = mediaRegistry.files[fileId] || {};
  mediaRegistry.files[fileId] = {
    ...existingEntry,
    fileId,
    fileName,
    container,
    durationSec,
    videoCodecs,
    audioCodecs,
    audioTracks,
    subtitleTracks,
    primaryTrackCompat,
    isEbmlRemappableDual,
    hasSidecarAudio0,
    sidecarAudioUrl: hasSidecarAudio0 ? `/media_cache/${fileId}/audio_0.m4a` : null,
    hasCompatMp4,
    compatMp4Url: hasCompatMp4 ? `/media_cache/${fileId}/compat.mp4` : null,
    updatedAt: new Date().toISOString()
  };
  saveMediaRegistry();

  // Determina a URL direta de reprodução para o player personalizado (sem nunca abrir o iframe do Google Drive!)
  let recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream`;
  if (hasCompatMp4) {
    recommendedCustomPlayerUrl = `/media_cache/${fileId}/compat.mp4`;
  } else if (preparedPath) {
    recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream?compat=1&audioTrack=0`;
  }

  const sidecarAudioUrl = hasSidecarAudio0
    ? `/media_cache/${fileId}/audio_0.m4a`
    : `/api/videos/${fileId}/audio-stream.m4a?track=0`;

  const diagnostic = {
    fileId,
    fileName,
    size: meta.size,
    duration: durationSec,
    container,
    videoCodecs,
    audioCodecs,
    audioTrackCount: audioTracks.length || 1,
    isDualAudio: audioTracks.length > 1 || detectedLanguages.length > 1,
    languages: detectedLanguages,
    audioTracks,
    subtitleTracks,
    fastStartMoov,
    ffmpegAvailable: hasFfmpeg,
    browserVideoSupported: container !== 'avi' && !videoCodecs.includes('H.265 (HEVC)'),
    browserAudioSupported: Boolean(preparedPath) || primaryTrackCompat || isEbmlRemappableDual || hasSidecarAudio0 || hasCompatMp4,
    primaryTrackCompat,
    isEbmlRemappableDual,
    hasSidecarAudio0,
    sidecarAudioUrl,
    hasCompatMp4,
    compatMp4Url: hasCompatMp4 ? `/media_cache/${fileId}/compat.mp4` : null,
    requiresSidecarAudio: !primaryTrackCompat && container !== 'avi' && !preparedPath,
    hasPreparedCompatibleStream: Boolean(preparedPath || hasCompatMp4),
    hasPreparedCompatibleAudio: Boolean(preparedPath || hasSidecarAudio0 || hasCompatMp4),
    requiresAudioFallbackOrRemux: Boolean(hasCompatMp4),
    recommendedCustomPlayerUrl,
    diagnosticReason: preparedPath || hasCompatMp4
      ? 'Versão MP4 (H.264 + AAC-LC Estéreo) pronta e armazenada no servidor.'
      : primaryTrackCompat
      ? `Áudio ${audioCodecs.join(' / ')} compatível nativamente com o Player Personalizado.`
      : isEbmlRemappableDual
      ? `Áudio Dual (${audioCodecs.join(' + ')}) com faixa AAC-LC Estéreo integrada e remapeada automaticamente no Player Personalizado.`
      : `Áudio original ${audioCodecs.join(', ')} convertido automaticamente para AAC-LC Estéreo sincronizado no Player Personalizado (vídeo original preservado).`
  };

  codecProbeCache.set(fileId, diagnostic);
  return diagnostic;
}

app.get('/api/videos/:id/diagnostics', async (req, res) => {
  const fileId = req.params.id;
  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ error: 'ID de arquivo inválido.' });
  }
  const diag = await probeMediaCodecs(fileId);
  if (diag.errorStatus) {
    return res.status(diag.errorStatus).json({ error: diag.error });
  }
  res.json(diag);
});

// ============================================================================
// FILA DE PROCESSAMENTO EM SEGUNDO PLANO & SERVIDOR HLS/MP4 COM ÁUDIO AAC-LC
// ============================================================================
const mediaJobQueue = [];
const activePreparationJobs = new Map(); // key: `${fileId}:${trackIdx}` -> jobState
let isProcessingQueue = false;

function enqueueFullMp4Preparation(fileId, audioTrack = 0) {
  const trackIdx = Math.max(0, parseInt(audioTrack, 10) || 0);
  const jobKey = `${fileId}:${trackIdx}`;
  const existingMp4 = getPreparedMp4Path(fileId, trackIdx);
  if (existingMp4) {
    return { status: 'ready', jobKey, path: existingMp4 };
  }
  if (activePreparationJobs.has(jobKey)) {
    return activePreparationJobs.get(jobKey);
  }
  const job = {
    jobKey,
    fileId,
    audioTrack: trackIdx,
    status: 'queued',
    queuedAt: new Date().toISOString()
  };
  activePreparationJobs.set(jobKey, job);
  mediaJobQueue.push(job);
  processNextMediaQueueJob();
  return job;
}

async function processNextMediaQueueJob() {
  if (isProcessingQueue || mediaJobQueue.length === 0) return;
  const hasFfmpeg = await checkFfmpegAvailable();
  if (!hasFfmpeg) return;

  isProcessingQueue = true;
  const job = mediaJobQueue.shift();
  if (!job) {
    isProcessingQueue = false;
    return;
  }

  try {
    job.status = 'processing';
    job.startedAt = new Date().toISOString();
    const diag = await probeMediaCodecs(job.fileId);
    const mediaDir = getFileMediaDir(job.fileId);
    const outPath = path.join(mediaDir, `compatible_a${job.audioTrack}.mp4`);
    const tempPath = path.join(mediaDir, `compatible_a${job.audioTrack}.tmp.mp4`);
    const localStreamUrl = `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(job.fileId)}/stream?raw=1`;
    const canCopyVideo = diag.container !== 'avi' && !(diag.videoCodecs || []).includes('H.265 (HEVC)');

    await new Promise((resolve) => {
      const args = [
        '-y',
        '-i',
        localStreamUrl,
        '-map',
        '0:v:0',
        '-map',
        `0:a:${job.audioTrack}`,
        ...(canCopyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        tempPath
      ];
      const ff = spawn(FFMPEG_BIN, args);
      ff.on('error', () => resolve(false));
      ff.on('close', (code) => {
        if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 65536) {
          try {
            fs.renameSync(tempPath, outPath);
            job.status = 'ready';
            job.completedAt = new Date().toISOString();
            codecProbeCache.delete(job.fileId);
          } catch (_) {
            job.status = 'failed';
          }
        } else {
          job.status = 'failed';
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch (_) {}
        }
        resolve(true);
      });
    });
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
  } finally {
    isProcessingQueue = false;
    if (mediaJobQueue.length > 0) {
      setImmediate(processNextMediaQueueJob);
    }
  }
}

// Geração sob demanda e com cache persistente de segmentos HLS (vídeo original H.264 copiado + áudio AAC-LC Estéreo)
const HLS_SEG_DURATION = 10;
const inFlightHlsSegments = new Map(); // `${fileId}:${trackIdx}:${segIdx}` -> Promise<string>

async function ensureHlsSegment(fileId, trackIdx, segIdx, diag) {
  const hlsDir = path.join(getFileMediaDir(fileId), `hls_a${trackIdx}`);
  fs.mkdirSync(hlsDir, { recursive: true });
  const segPath = path.join(hlsDir, `seg_${segIdx}.ts`);

  if (fs.existsSync(segPath) && fs.statSync(segPath).size > 1024) {
    return segPath;
  }

  const segKey = `${fileId}:${trackIdx}:${segIdx}`;
  if (inFlightHlsSegments.has(segKey)) {
    return inFlightHlsSegments.get(segKey);
  }

  const promise = (async () => {
    const startSec = segIdx * HLS_SEG_DURATION;
    const totalDur = Number(diag && diag.duration) || 7200;
    const segDur = Math.min(HLS_SEG_DURATION, Math.max(1, totalDur - startSec));
    // Quando startSec > 0, seek=1 sinaliza ao proxy local para responder head_1mb.bin e tail_512kb.bin em < 1ms
    const localStreamUrl =
      startSec > 0
        ? `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1&seek=1&chunkMB=6`
        : `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1&chunkMB=6`;
    const canCopyVideo = diag && diag.container !== 'avi' && !(diag.videoCodecs || []).includes('H.265 (HEVC)');
    const tmpPath = path.join(hlsDir, `seg_${segIdx}.tmp.ts`);

    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-threads',
        '2',
        '-reconnect',
        '1',
        '-reconnect_at_eof',
        '1',
        '-reconnect_streamed',
        '1',
        '-probesize',
        '1000000',
        '-analyzeduration',
        '1000000',
        ...(startSec > 0 ? ['-ss', String(startSec)] : []),
        '-t',
        String(segDur),
        '-i',
        localStreamUrl,
        '-map',
        '0:v:0',
        '-map',
        `0:a:${trackIdx}?`,
        ...(canCopyVideo
          ? ['-c:v', 'copy']
          : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p']),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ac',
        '2',
        '-output_ts_offset',
        String(startSec),
        '-f',
        'mpegts',
        tmpPath
      ];

      execFile(FFMPEG_BIN, args, { timeout: 30000 }, (err) => {
        if (!err && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 512) {
          try {
            fs.renameSync(tmpPath, segPath);
            return resolve(segPath);
          } catch (renameErr) {
            return reject(renameErr);
          }
        }
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (_) {}
        reject(err || new Error('Falha ao gerar segmento HLS compatível.'));
      });
    });
  })().finally(() => {
    inFlightHlsSegments.delete(segKey);
  });

  inFlightHlsSegments.set(segKey, promise);
  return promise;
}

// Stream de áudio AAC-LC sob demanda (para sidecar <audio> quando seeking além do cache inicial ou seleção de faixa)
app.get('/api/videos/:id/audio-stream.m4a', async (req, res) => {
  const fileId = req.params.id;
  const trackIdx = Math.max(0, parseInt(req.query.audioTrack || req.query.track || '0', 10) || 0);
  const startSec = Math.max(0, Number(req.query.start) || 0);

  if (!isValidDriveFileId(fileId)) return res.status(400).end();
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) return res.status(403).end();

  if (startSec === 0 && trackIdx === 0) {
    const cachedM4a = path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'audio_0.m4a');
    if (fs.existsSync(cachedM4a) && fs.statSync(cachedM4a).size > 1024) {
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(cachedM4a).pipe(res);
    }
  }

  const hasFfmpeg = await checkFfmpegAvailable();
  if (!hasFfmpeg) return res.status(503).json({ error: 'FFmpeg indisponível.' });

  const localStreamUrl = `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1&chunkMB=8`;
  res.status(200);
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Cache-Control', 'no-store');

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-reconnect',
    '1',
    '-reconnect_at_eof',
    '1',
    '-reconnect_streamed',
    '1',
    '-probesize',
    '1500000',
    '-analyzeduration',
    '1500000',
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    '-i',
    localStreamUrl,
    '-vn',
    '-map',
    `0:a:${trackIdx}?`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1'
  ];

  const ff = spawn(FFMPEG_BIN, args);
  req.on('close', () => {
    try {
      ff.kill('SIGKILL');
    } catch (_) {}
  });
  ff.stdout.pipe(res);
  ff.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
});

// Stream MP4 fragmentado progressivo em tempo real (-c:v copy -c:a aac) com encerramento automático ao desconectar
app.get('/api/videos/:id/remux.mp4', async (req, res) => {
  const fileId = req.params.id;
  const trackIdx = Math.max(0, parseInt(req.query.audioTrack || req.query.track || '0', 10) || 0);
  const startSec = Math.max(0, Number(req.query.start) || 0);

  if (!isValidDriveFileId(fileId)) return res.status(400).end();
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) return res.status(403).end();

  const preparedMp4 = getPreparedMp4Path(fileId, trackIdx);
  if (preparedMp4 && startSec === 0) {
    return handleVideoStreamRequest(req, res);
  }

  const hasFfmpeg = await checkFfmpegAvailable();
  if (!hasFfmpeg) return res.status(503).json({ error: 'FFmpeg indisponível.' });

  const diag = await probeMediaCodecs(fileId);
  const canCopyVideo = diag && diag.container !== 'avi' && !(diag.videoCodecs || []).includes('H.265 (HEVC)');
  const localStreamUrl =
    startSec > 0
      ? `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1&seek=1&chunkMB=8`
      : `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1&chunkMB=8`;

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-probesize',
    '1000000',
    '-analyzeduration',
    '1000000',
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    '-i',
    localStreamUrl,
    '-map',
    '0:v:0',
    '-map',
    `0:a:${trackIdx}?`,
    ...(canCopyVideo
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p']),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ac',
    '2',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof+faststart',
    '-f',
    'mp4',
    'pipe:1'
  ];

  const ff = spawn(FFMPEG_BIN, args);
  req.on('close', () => {
    try {
      ff.kill('SIGKILL');
    } catch (_) {}
  });
  ff.stdout.pipe(res);
  ff.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
});

// Playlist HLS VOD para reprodução direta no <video id="nativeVideo"> via Hls.js
app.get('/api/videos/:id/hls/:track/playlist.m3u8', async (req, res) => {
  const fileId = req.params.id;
  const trackIdx = Math.max(0, parseInt(req.params.track, 10) || 0);
  if (!isValidDriveFileId(fileId)) {
    return res.status(400).send('ID inválido');
  }
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) {
    return res.status(403).send('Não autorizado');
  }

  try {
    const diag = await probeMediaCodecs(fileId);
    if (diag.errorStatus) {
      return res.status(diag.errorStatus).send(diag.error);
    }

    const totalDuration = Number(diag.duration) > 0 ? Number(diag.duration) : 7200;
    const totalSegments = Math.ceil(totalDuration / HLS_SEG_DURATION);

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-TARGETDURATION:${HLS_SEG_DURATION}`,
      '#EXT-X-MEDIA-SEQUENCE:0'
    ];

    for (let i = 0; i < totalSegments; i += 1) {
      const rem = totalDuration - i * HLS_SEG_DURATION;
      const dur = Math.min(HLS_SEG_DURATION, Math.max(0.5, rem));
      lines.push(`#EXTINF:${dur.toFixed(3)},`);
      lines.push(`/api/videos/${encodeURIComponent(fileId)}/hls/${trackIdx}/seg_${i}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    res.status(500).send('Erro ao gerar playlist HLS: ' + err.message);
  }
});

app.get('/api/videos/:id/hls/:track/seg_:segIdx.ts', async (req, res) => {
  const fileId = req.params.id;
  const trackIdx = Math.max(0, parseInt(req.params.track, 10) || 0);
  const segIdx = Math.max(0, parseInt(req.params.segIdx, 10) || 0);
  const reqStartMs = Date.now();

  if (!isValidDriveFileId(fileId)) {
    return res.status(400).end();
  }
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) {
    return res.status(403).end();
  }

  try {
    const diag = await probeMediaCodecs(fileId);
    const segPath = await ensureHlsSegment(fileId, trackIdx, segIdx, diag);

    // Só pré-aquece o próximo segmento se não houver outros segmentos HLS em geração concorrente
    const totalDuration = Number(diag && diag.duration) || 7200;
    if ((segIdx + 1) * HLS_SEG_DURATION < totalDuration && inFlightHlsSegments.size === 0) {
      setImmediate(() => {
        ensureHlsSegment(fileId, trackIdx, segIdx + 1, diag).catch(() => {});
      });
    }

    recordTtfbMetric(Date.now() - reqStartMs, `hls_seg_${segIdx}`);
    const stat = fs.statSync(segPath);
    res.status(200);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(segPath).pipe(res);
  } catch (err) {
    console.warn(`[HLS Segment Error] fileId=${fileId} track=${trackIdx} seg=${segIdx}: ${err.message}`);
    res.status(502).json({ error: 'Falha ao processar segmento de vídeo/áudio: ' + err.message });
  }
});

// Extração sob demanda de legendas embutidas para WebVTT
app.get('/api/videos/:id/subtitles/:subIdx.vtt', async (req, res) => {
  const fileId = req.params.id;
  const subIdx = Math.max(0, parseInt(req.params.subIdx, 10) || 0);
  if (!isValidDriveFileId(fileId)) return res.status(400).end();

  const mediaDir = getFileMediaDir(fileId);
  const vttPath = path.join(mediaDir, `sub_${subIdx}.vtt`);
  if (fs.existsSync(vttPath) && fs.statSync(vttPath).size > 16) {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    return fs.createReadStream(vttPath).pipe(res);
  }

  const localStreamUrl = `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1`;
  execFile(
    FFMPEG_BIN,
    ['-y', '-i', localStreamUrl, '-map', `0:s:${subIdx}`, '-f', 'webvtt', vttPath],
    { timeout: 45000 },
    (err) => {
      if (!err && fs.existsSync(vttPath)) {
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        return fs.createReadStream(vttPath).pipe(res);
      }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.send('WEBVTT\n\n');
    }
  );
});

app.post('/api/videos/:id/prepare-audio', async (req, res) => {
  const fileId = req.params.id;
  const trackIdx = Math.max(0, parseInt((req.body && req.body.trackIndex) || 0, 10) || 0);
  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ error: 'ID de arquivo inválido.' });
  }

  const existingPrepared = getPreparedMp4Path(fileId, trackIdx);
  if (existingPrepared) {
    return res.json({
      success: true,
      status: 'ready',
      streamUrl: `/api/videos/${fileId}/stream?compat=1&audioTrack=${trackIdx}`,
      hlsUrl: `/api/videos/${fileId}/hls/${trackIdx}/playlist.m3u8`,
      message: 'Versão compatível (MP4 H.264 + AAC-LC Estéreo) já está pronta.'
    });
  }

  const hasFfmpeg = await checkFfmpegAvailable();
  const diag = await probeMediaCodecs(fileId);
  if (!hasFfmpeg) {
    return res.status(200).json({
      success: true,
      status: 'unavailable_ffmpeg',
      ffmpegAvailable: false,
      diagnostics: diag
    });
  }

  // Enfileira preparação de MP4 completo em background e retorna a rota HLS imediata para o player personalizado
  const job = enqueueFullMp4Preparation(fileId, trackIdx);
  return res.json({
    success: true,
    status: job.status,
    ffmpegAvailable: true,
    hlsUrl: `/api/videos/${fileId}/hls/${trackIdx}/playlist.m3u8`,
    streamUrl: `/api/videos/${fileId}/hls/${trackIdx}/playlist.m3u8`,
    message: 'Stream compatível AAC-LC ativo no Player Personalizado e versão MP4 enfileirada.'
  });
});

// ============================================================================
// FASE 3 & FASE 5.2 — PREVIEW DE CENAS NA BARRA DE REPRODUÇÃO (SEM BLOQUEAR STREAMING)
// ============================================================================
const inFlightThumbnails = new Map(); // `${fileId}:${quantizedT}` -> Promise<string>
let activeThumbnailProcesses = 0;

function getThumbnailInterval(durationSec) {
  if (!durationSec || durationSec <= 0) return 10;
  // Filmes curtos (<= 30 min): intervalo de 5s; Filmes longos (> 30 min): intervalo de 10s
  return durationSec <= 1800 ? 5 : 10;
}

function formatWebVttTimestamp(sec) {
  const total = Math.max(0, Number(sec) || 0);
  const hrs = String(Math.floor(total / 3600)).padStart(2, '0');
  const mins = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const secs = (total % 60).toFixed(3).padStart(6, '0');
  return `${hrs}:${mins}:${secs}`;
}

async function ensureThumbnailFrame(fileId, quantizedSec) {
  const thumbsDir = path.join(getFileMediaDir(fileId), 'thumbs');
  fs.mkdirSync(thumbsDir, { recursive: true });
  const tInt = Math.max(0, Math.floor(quantizedSec));
  const thumbPath = path.join(thumbsDir, `thumb_${tInt}.jpg`);

  if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 256) {
    return thumbPath;
  }

  const lockKey = `${fileId}:${tInt}`;
  if (inFlightThumbnails.has(lockKey)) {
    return inFlightThumbnails.get(lockKey);
  }

  // Limita concorrência de processos de thumbnail para nunca competir com o buffer de vídeo
  if (activeThumbnailProcesses >= 1) {
    throw new Error('Geração de miniatura adiada para priorizar o streaming de vídeo.');
  }

  const promise = (async () => {
    const hasFfmpeg = await checkFfmpegAvailable();
    if (!hasFfmpeg) {
      throw new Error('FFmpeg indisponível para extrair miniatura.');
    }

    activeThumbnailProcesses += 1;
    const preparedMp4 = getPreparedMp4Path(fileId, 0);
    // chunkMB=1 garante que o FFmpeg baixe no máximo 1MB do Google Drive para extrair 1 frame JPEG!
    const inputSource =
      preparedMp4 ||
      `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1&seek=1&chunkMB=3`;
    const tmpPath = path.join(thumbsDir, `thumb_${tInt}.tmp.jpg`);

    return new Promise((resolve, reject) => {
      execFile(
        FFMPEG_BIN,
        [
          '-y',
          '-threads',
          '1',
          ...(preparedMp4
            ? []
            : ['-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1']),
          '-probesize',
          '1500000',
          '-analyzeduration',
          '1500000',
          ...(tInt > 0 ? ['-ss', String(tInt)] : []),
          '-i',
          inputSource,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-q:v',
          '5',
          tmpPath
        ],
        { timeout: 10000 },
        (err) => {
          if (!err && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 256) {
            try {
              fs.renameSync(tmpPath, thumbPath);
              return resolve(thumbPath);
            } catch (e) {
              return reject(e);
            }
          }
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch (_) {}
          reject(err || new Error('Não foi possível gerar miniatura para este instante.'));
        }
      );
    });
  })().finally(() => {
    activeThumbnailProcesses = Math.max(0, activeThumbnailProcesses - 1);
    inFlightThumbnails.delete(lockKey);
  });

  inFlightThumbnails.set(lockKey, promise);
  return promise;
}

app.get('/api/videos/:id/thumbnails/meta', async (req, res) => {
  const fileId = req.params.id;
  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ available: false, error: 'ID inválido' });
  }
  const cachedMetaFile = path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'meta.json');
  if (fs.existsSync(cachedMetaFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cachedMetaFile, 'utf8'));
      return res.json(parsed);
    } catch (_) {}
  }
  try {
    const hasFfmpeg = await checkFfmpegAvailable();
    const diag = await probeMediaCodecs(fileId);
    if (diag.errorStatus || !hasFfmpeg) {
      return res.json({
        available: false,
        fileId,
        reason: diag.error || 'Miniaturas indisponíveis neste ambiente.'
      });
    }

    const duration = Number(diag.duration) || 0;
    const interval = getThumbnailInterval(duration);
    const count = duration > 0 ? Math.ceil(duration / interval) : 0;

    // IMPORTANTE (FASE 1.2 & FASE 5.2): NÃO dispara warmUpKeyThumbnails no clique do filme para nunca concorrer com o início da reprodução!
    res.json({
      available: true,
      fileId,
      duration,
      interval,
      intervalSeconds: interval,
      count,
      width: 160,
      height: 90,
      vttUrl: `/api/videos/${encodeURIComponent(fileId)}/thumbnails.vtt`,
      frameEndpoint: `/api/videos/${encodeURIComponent(fileId)}/thumbnails/frame`
    });
  } catch (err) {
    res.json({ available: false, fileId, error: err.message });
  }
});

app.get('/api/videos/:id/thumbnails.vtt', async (req, res) => {
  const fileId = req.params.id;
  if (!isValidDriveFileId(fileId)) return res.status(400).end();

  const cachedVttFile = path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'thumbnails.vtt');
  if (fs.existsSync(cachedVttFile)) {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return fs.createReadStream(cachedVttFile).pipe(res);
  }

  try {
    const diag = await probeMediaCodecs(fileId);
    const duration = Number(diag && diag.duration) || 0;
    const interval = getThumbnailInterval(duration);
    const lines = ['WEBVTT', ''];

    if (duration > 0) {
      const count = Math.ceil(duration / interval);
      for (let i = 0; i < count; i += 1) {
        const start = i * interval;
        const end = Math.min(duration, (i + 1) * interval);
        lines.push(`${formatWebVttTimestamp(start)} --> ${formatWebVttTimestamp(end)}`);
        lines.push(`/api/videos/${encodeURIComponent(fileId)}/thumbnails/frame?t=${start}`);
        lines.push('');
      }
    }

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(lines.join('\n'));
  } catch (_) {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send('WEBVTT\n\n');
  }
});

app.get('/api/videos/:id/thumbnails/frame', async (req, res) => {
  const fileId = req.params.id;
  if (!isValidDriveFileId(fileId)) return res.status(400).end();
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) {
    return res.status(403).end();
  }

  try {
    const rawT = Math.max(0, Number(req.query.t) || 0);
    const diag = codecProbeCache.get(fileId);
    const duration = Number(diag && diag.duration) || 7200;
    const interval = getThumbnailInterval(duration);
    const quantizedT = Math.min(
      Math.max(0, Math.floor(duration - 1)),
      Math.floor(rawT / interval) * interval
    );

    const thumbPath = await ensureThumbnailFrame(fileId, quantizedT);
    const stat = fs.statSync(thumbPath);
    res.status(200);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    const fallbackThumb = path.join(PUBLIC_MEDIA_CACHE_DIR, fileId, 'thumb_0.jpg');
    if (fs.existsSync(fallbackThumb)) {
      res.status(200);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(fallbackThumb).pipe(res);
    }
    res.status(404).json({ error: 'Miniatura não disponível para este timestamp.' });
  }
});

async function handleVideoMetadataRequest(req, res) {
  const fileId = req.params.id || req.params.fileId;
  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ error: 'ID de arquivo do Google Drive inválido.' });
  }
  const meta = await getDriveFileMetadata(fileId);
  if (meta.errorStatus) {
    return res.status(meta.errorStatus).json({ error: meta.error });
  }
  return res.json({
    id: meta.id,
    fileId: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    canDownload: meta.canDownload,
    source: meta.source
  });
}

const patchEbmlHeaderForDualAudioMkv = patchEbmlHeaderForUnsupportedAudio;

async function handleVideoStreamRequest(req, res) {
  const reqStartMs = Date.now();
  const fileId = req.params.id || req.params.fileId;
  const isRawInternal = req.query.raw === '1';
  const isSeekProbe = req.query.seek === '1';
  const customChunkMB = Math.min(16, Math.max(1, parseInt(req.query.chunkMB || '0', 10) || 0));
  const requestedTrack = Math.max(0, parseInt(req.query.audioTrack, 10) || 0);

  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ error: 'ID de arquivo inválido.' });
  }

  // Garante que apenas arquivos cadastrados no catálogo autorizado (ou com permissão explícita) sejam transmitidos
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) {
    logStructured('AUTH_RBAC', 'unauthorized_stream_blocked', { fileId, cid: req.correlationId });
    return res.status(403).json({ error: 'Arquivo não autorizado neste catálogo.' });
  }

  if (!isRawInternal) {
    platformMetrics.totalStreamRequests += 1;
    platformMetrics.activeClientStreams += 1;
    res.on('close', () => {
      platformMetrics.activeClientStreams = Math.max(0, platformMetrics.activeClientStreams - 1);
    });
  }

  // Se houver versão MP4 com áudio AAC preparada localmente e não for chamada interna raw=1, serve com suporte a HTTP 206 Range
  if (!isRawInternal) {
    const preparedMp4 = getPreparedMp4Path(fileId, requestedTrack);
    if (preparedMp4) {
      try {
        const stat = fs.statSync(preparedMp4);
        const totalSize = stat.size;
        const rangeHeader = req.headers.range;
        let start = 0;
        let end = totalSize - 1;
        if (rangeHeader) {
          const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
          if (!m) {
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.status(416).end();
          }
          start = m[1] ? parseInt(m[1], 10) : 0;
          end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
          if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= totalSize || end < start) {
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.status(416).end();
          }
        }
        recordTtfbMetric(Date.now() - reqStartMs, 'prepared_local_mp4');
        res.status(206);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        res.setHeader('Content-Length', String(end - start + 1));
        res.setHeader('Accept-Ranges', 'bytes');
        return fs.createReadStream(preparedMp4, { start, end }).pipe(res);
      } catch (_) {}
    }
  }

  const abortController = new AbortController();
  let upstreamNodeStream = null;

  const cleanupUpstream = () => {
    try {
      abortController.abort();
    } catch (_) {}
    if (upstreamNodeStream) {
      try {
        upstreamNodeStream.destroy();
      } catch (_) {}
    }
  };
  req.on('close', cleanupUpstream);

  try {
    const meta = await getDriveFileMetadata(fileId);
    if (meta.errorStatus) {
      return res.status(meta.errorStatus).json({ error: meta.error });
    }
    if (!meta.canDownload || !meta.size) {
      return res.status(403).json({ error: 'Arquivo sem permissão de download ou tamanho indisponível.' });
    }

    const totalSize = meta.size;
    // IMPORTANTE: O Google Drive retorna página HTML se o cabeçalho Range pedir 0 até totalSize-1 (arquivo inteiro).
    const MAX_CHUNK_BYTES = customChunkMB
      ? customChunkMB * 1024 * 1024
      : isRawInternal
      ? 12 * 1024 * 1024
      : process.env.VERCEL
      ? 2 * 1024 * 1024
      : 8 * 1024 * 1024;
    const rangeHeader = req.headers.range;

    let start = 0;
    let end = Math.min(MAX_CHUNK_BYTES - 1, totalSize - 1);

    if (rangeHeader) {
      const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }

      if (match[1] === '' && match[2] !== '') {
        const suffixLen = parseInt(match[2], 10);
        if (Number.isNaN(suffixLen) || suffixLen <= 0) {
          res.setHeader('Content-Range', `bytes */${totalSize}`);
          return res.status(416).end();
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
          res.setHeader('Content-Range', `bytes */${totalSize}`);
          return res.status(416).end();
        }

        end = Math.min(requestedEnd, start + MAX_CHUNK_BYTES - 1, totalSize - 1);
      }
    }

    const mediaDir = path.join(PREPARED_MEDIA_DIR, fileId);
    const headPath = path.join(mediaDir, 'head_1mb.bin');
    const tailPath = path.join(mediaDir, 'tail_512kb.bin');
    const HEAD_SIZE = Math.min(1024 * 1024, totalSize);
    const TAIL_SIZE = Math.min(512 * 1024, totalSize);
    const tailStart = Math.max(0, totalSize - TAIL_SIZE);

    // 1. Se a requisição inicial estiver no primeiro 1MB (head_1mb.bin) e for do navegador (<video>) ou probe de cabeçalho (seek=1),
    // entrega o primeiro 1MB do disco local em < 1ms (TTFB instantâneo para loadedmetadata + primeiros keyframes!)
    if (start < HEAD_SIZE && fs.existsSync(headPath) && (!isRawInternal || isSeekProbe || end < HEAD_SIZE)) {
      try {
        const headStat = fs.statSync(headPath);
        if (headStat.size === HEAD_SIZE) {
          const localEnd = Math.min(end, HEAD_SIZE - 1);
          const chunkLen = localEnd - start + 1;
          platformMetrics.headCacheHits += 1;
          recordTtfbMetric(Date.now() - reqStartMs, 'head_1mb_cache');
          res.status(206);
          res.setHeader('Content-Type', meta.mimeType);
          res.setHeader('Content-Range', `bytes ${start}-${localEnd}/${totalSize}`);
          res.setHeader('Content-Length', String(chunkLen));
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          const regEntry = mediaRegistry && mediaRegistry.files && mediaRegistry.files[fileId];
          const shouldPatchEbml =
            !isRawInternal &&
            start === 0 &&
            ((regEntry && regEntry.isEbmlRemappableDual) || /\.mkv$/i.test(meta.name || ''));
          if (shouldPatchEbml) {
            const rawSlice = fs.readFileSync(headPath).subarray(start, localEnd + 1);
            return res.end(patchEbmlHeaderForDualAudioMkv(rawSlice));
          }
          return fs.createReadStream(headPath, { start, end: localEnd }).pipe(res);
        }
      } catch (_) {}
    }

    // 2. Se a requisição estiver dentro do cache de extremidade final (tail_512kb.bin, ex: MKV Cues / MP4 moov no fim),
    // responde instantaneamente do disco local em < 1ms!
    if (start >= tailStart && fs.existsSync(tailPath)) {
      try {
        const tailStat = fs.statSync(tailPath);
        if (tailStat.size === TAIL_SIZE) {
          const localStart = start - tailStart;
          const localEnd = Math.min(end - tailStart, TAIL_SIZE - 1);
          const chunkLen = localEnd - localStart + 1;
          platformMetrics.tailCacheHits += 1;
          recordTtfbMetric(Date.now() - reqStartMs, 'tail_512kb_cache');
          res.status(206);
          res.setHeader('Content-Type', meta.mimeType);
          res.setHeader('Content-Range', `bytes ${start}-${tailStart + localEnd}/${totalSize}`);
          res.setHeader('Content-Length', String(chunkLen));
          res.setHeader('Accept-Ranges', 'bytes');
          return fs.createReadStream(tailPath, { start: localStart, end: localEnd }).pipe(res);
        }
      } catch (_) {}
    }

    // Dispara preenchimento assíncrono do cache head_1mb.bin + tail_512kb.bin na primeira reprodução
    if (!isRawInternal && (!fs.existsSync(headPath) || !fs.existsSync(tailPath))) {
      setImmediate(() => {
        ensureHeadTailCache(fileId, totalSize).catch(() => {});
      });
    }

    const googleOAuthToken = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();
    const googleApiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();

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
      redirect: 'follow',
      signal: abortController.signal
    });

    if (!upstream.ok && upstream.status !== 206) {
      logStructured('VIDEO_STREAM', 'upstream_error', {
        fileId,
        status: upstream.status,
        cid: req.correlationId
      });
      return res.status(upstream.status).json({
        error: 'Falha ao obter fluxo de vídeo do Google Drive.'
      });
    }

    const upstreamType = upstream.headers.get('content-type') || '';
    if (upstreamType.includes('text/html')) {
      logStructured('VIDEO_STREAM', 'html_blocked_by_drive', { fileId, cid: req.correlationId });
      return res.status(403).json({
        error: 'O Google Drive retornou página de bloqueio em vez dos bytes do vídeo.'
      });
    }

    const ttfbMs = Date.now() - reqStartMs;
    if (!isRawInternal) {
      recordTtfbMetric(ttfbMs, meta.source);
      logStructured('VIDEO_STREAM', 'stream_206_started', {
        fileId,
        range: `${start}-${end}/${totalSize}`,
        ttfbMs,
        cid: req.correlationId
      });
    }

    const chunkLen = end - start + 1;
    res.status(206);
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', String(chunkLen));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!upstream.body) {
      return res.status(502).end();
    }

    upstreamNodeStream = Readable.fromWeb(upstream.body);
    upstreamNodeStream.on('error', (streamErr) => {
      if (streamErr.name !== 'AbortError') {
        console.error(`[Stream Pipe Error] fileId=${fileId}: ${streamErr.message}`);
      }
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.end();
      }
    });
    upstreamNodeStream.pipe(res);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error(`[Stream Fatal Error] fileId=${fileId}: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro interno no streaming: ' + err.message });
    }
  }
}

// ============================================================================
// AQUECIMENTO INTELIGENTE EM OCIOSIDADE (HEAD/TAIL + FFPROBE + SEG_0 HLS)
// Executa apenas 1 arquivo por vez e pausa imediatamente se houver usuário assistindo!
// ============================================================================
let isIdleWarmupRunning = false;

async function scheduleIdleCatalogWarmup() {
  if (isIdleWarmupRunning || process.env.VERCEL) return;
  isIdleWarmupRunning = true;
  try {
    const movies = Array.isArray(driveCatalog.movies) ? [...driveCatalog.movies] : [];
    for (const movie of movies) {
      if (!movie || !movie.driveFileId || movie.unavailable || movie.trashed) continue;
      // Prioridade absoluta ao streaming ativo do usuário
      if (platformMetrics.activeClientStreams > 0 || inFlightHlsSegments.size > 0) {
        await new Promise((r) => setTimeout(r, 3000));
        if (platformMetrics.activeClientStreams > 0) continue;
      }

      const fileId = movie.driveFileId;
      const mediaDir = getFileMediaDir(fileId);
      const headPath = path.join(mediaDir, 'head_1mb.bin');
      const probePath = path.join(mediaDir, 'ffprobe.json');

      if (!fs.existsSync(headPath) || !fs.existsSync(probePath) || !codecProbeCache.has(fileId)) {
        try {
          const diag = await probeMediaCodecs(fileId);
          // Se o filme possuir áudio AC-3/E-AC-3/DTS que usa HLS, pré-gera seg_0.ts (~1.5MB) para início em < 0.3s!
          if (diag && diag.requiresAudioFallbackOrRemux && platformMetrics.activeClientStreams === 0) {
            const seg0Path = path.join(mediaDir, 'hls_a0', 'seg_0.ts');
            if (!fs.existsSync(seg0Path)) {
              await ensureHlsSegment(fileId, 0, 0, diag).catch(() => {});
            }
          }
        } catch (_) {}
      } else {
        const diag = codecProbeCache.get(fileId);
        if (diag && diag.requiresAudioFallbackOrRemux && platformMetrics.activeClientStreams === 0) {
          const seg0Path = path.join(mediaDir, 'hls_a0', 'seg_0.ts');
          if (!fs.existsSync(seg0Path)) {
            await ensureHlsSegment(fileId, 0, 0, diag).catch(() => {});
          }
        }
      }
    }
  } finally {
    isIdleWarmupRunning = false;
  }
}

app.get('/api/videos/:id/meta', handleVideoMetadataRequest);
app.get('/api/gdrive/meta/:fileId', handleVideoMetadataRequest);
app.get('/api/videos/:id/stream', handleVideoStreamRequest);
app.get('/api/gdrive/stream/:fileId', handleVideoStreamRequest);

// ==========================================
// GERENCIAMENTO DE SALAS DE CINEMA (12 POLTRONAS + WEBSOCKETS)
// ==========================================
const rooms = new Map();

function getInitialMovieForRoom() {
  const rawFirst = driveCatalog.movies[0] || DEFAULT_DRIVE_CATALOG.movies[0];
  const first = enrichMovieWithPlaybackInfo(rawFirst);
  return {
    id: first.id,
    title: first.title,
    year: first.year || 'HD',
    category: first.category || 'Google Drive',
    poster: first.poster,
    backdrop: first.backdrop || first.poster,
    overview: first.overview,
    streamUrl: first.streamUrl,
    driveFileId: first.driveFileId || extractDriveFileId(first.rawUrl || first.streamUrl),
    duration: first.duration || 0,
    recommendedCustomPlayerUrl: first.recommendedCustomPlayerUrl || first.streamUrl,
    requiresAudioFallbackOrRemux: Boolean(first.requiresAudioFallbackOrRemux),
    container: first.container || 'mp4',
    videoCodecs: first.videoCodecs || [],
    audioCodecs: first.audioCodecs || []
  };
}

function createDefaultRoom(roomId, roomName, password, hostSocketId) {
  return {
    id: roomId,
    name: roomName || `Sessão ${roomId}`,
    password: password || '',
    hostSocketId,
    freeControl: false,
    lightsOff: false,
    seats: Array(MAX_SEATS).fill(null),
    participants: new Map(),
    media: getInitialMovieForRoom(),
    playback: {
      status: 'paused',
      currentTime: 0,
      playbackRate: 1,
      updatedAt: Date.now()
    },
    chatHistory: []
  };
}

function getEffectiveCurrentTime(playback) {
  if (playback.status === 'playing') {
    const elapsedSec = (Date.now() - playback.updatedAt) / 1000;
    return Math.max(0, playback.currentTime + elapsedSec * (playback.playbackRate || 1));
  }
  return playback.currentTime;
}

function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hasPassword: Boolean(room.password),
    hostSocketId: room.hostSocketId,
    freeControl: room.freeControl,
    lightsOff: room.lightsOff,
    seats: room.seats,
    participantCount: room.participants.size,
    maxSeats: MAX_SEATS,
    media: room.media,
    playback: {
      status: room.playback.status,
      currentTime: getEffectiveCurrentTime(room.playback),
      playbackRate: room.playback.playbackRate,
      serverTimestamp: Date.now()
    },
    chatHistory: room.chatHistory.slice(-50)
  };
}

function canControlRoom(room, socketId) {
  return room.hostSocketId === socketId || room.freeControl;
}

function addSystemMessage(room, text) {
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'system',
    text,
    timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };
  room.chatHistory.push(msg);
  if (room.chatHistory.length > 80) room.chatHistory.shift();
  io.to(room.id).emit('chat_message', msg);
}

app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const room of rooms.values()) {
    list.push({
      id: room.id,
      name: room.name,
      hasPassword: Boolean(room.password),
      participantCount: room.participants.size,
      maxSeats: MAX_SEATS,
      currentMovie: room.media.title,
      poster: room.media.poster
    });
  }
  res.json(list);
});

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join_room', ({ roomId, roomName, password, userName, avatar, preferredSeat }, callback) => {
    try {
      const cleanRoomId = String(roomId || 'SALA-POMPEIA')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-_]/g, '');

      let room = rooms.get(cleanRoomId);

      if (!room) {
        room = createDefaultRoom(cleanRoomId, roomName, password, socket.id);
        rooms.set(cleanRoomId, room);
      } else {
        if (room.password && room.password !== (password || '')) {
          return callback && callback({ error: 'Senha incorreta para entrar nesta sala de cinema.' });
        }
        if (room.participants.size >= MAX_SEATS && !room.participants.has(socket.id)) {
          return callback && callback({
            error: `Sessão lotada! Todas as ${MAX_SEATS} poltronas desta sala já estão ocupadas.`
          });
        }
      }

      let seatIndex = -1;
      if (
        typeof preferredSeat === 'number' &&
        preferredSeat >= 0 &&
        preferredSeat < MAX_SEATS &&
        !room.seats[preferredSeat]
      ) {
        seatIndex = preferredSeat;
      } else {
        seatIndex = room.seats.findIndex((s) => s === null);
      }

      if (seatIndex === -1) {
        return callback && callback({ error: 'Não há poltronas disponíveis na sala.' });
      }

      const participant = {
        socketId: socket.id,
        name: String(userName || 'Convidado').trim().slice(0, 22) || 'Convidado',
        avatar: avatar || '🍿',
        seatIndex,
        joinedAt: Date.now()
      };

      room.seats[seatIndex] = participant;
      room.participants.set(socket.id, participant);
      currentRoomId = cleanRoomId;
      socket.join(cleanRoomId);

      if (!room.participants.has(room.hostSocketId)) {
        room.hostSocketId = socket.id;
      }

      const seatLabel = seatIndex < 6 ? `A${seatIndex + 1}` : `B${seatIndex - 5}`;
      addSystemMessage(room, `${participant.avatar} ${participant.name} sentou na poltrona ${seatLabel}.`);

      const state = serializeRoom(room);
      io.to(cleanRoomId).emit('room_state', state);

      if (callback) callback({ success: true, room: state, mySocketId: socket.id });
    } catch (err) {
      if (callback) callback({ error: err.message });
    }
  });

  socket.on('select_seat', ({ seatIndex }, callback) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const participant = room.participants.get(socket.id);
    if (!participant) return;

    const idx = Number(seatIndex);
    if (Number.isNaN(idx) || idx < 0 || idx >= MAX_SEATS) return;

    if (room.seats[idx] && room.seats[idx].socketId !== socket.id) {
      return callback && callback({ error: 'Esta poltrona já está ocupada por outro amigo!' });
    }

    if (participant.seatIndex >= 0 && participant.seatIndex < MAX_SEATS) {
      room.seats[participant.seatIndex] = null;
    }

    participant.seatIndex = idx;
    room.seats[idx] = participant;

    const seatLabel = idx < 6 ? `A${idx + 1}` : `B${idx - 5}`;
    addSystemMessage(room, `${participant.avatar} ${participant.name} mudou para a poltrona ${seatLabel}.`);
    io.to(room.id).emit('room_state', serializeRoom(room));
    if (callback) callback({ success: true, seatIndex: idx });
  });

  socket.on('change_media', (newMedia) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!canControlRoom(room, socket.id)) return;

    const participant = room.participants.get(socket.id);
    if (newMedia.rawUrl && !newMedia.streamUrl) {
      newMedia.streamUrl = buildStreamUrl(newMedia.rawUrl);
    }

    room.media = enrichMovieWithPlaybackInfo({
      ...room.media,
      ...newMedia
    });

    room.playback = {
      status: 'paused',
      currentTime: 0,
      playbackRate: 1,
      updatedAt: Date.now()
    };

    if (participant && newMedia.title) {
      addSystemMessage(
        room,
        `🎬 ${participant.name} colocou no telão (Google Drive): "${room.media.title}"`
      );
    }

    io.to(room.id).emit('media_changed', {
      media: room.media,
      playback: serializeRoom(room).playback
    });
    io.to(room.id).emit('room_state', serializeRoom(room));
  });

  socket.on('playback_command', ({ action, currentTime, playbackRate }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!canControlRoom(room, socket.id)) return;

    const participant = room.participants.get(socket.id);
    const numericTime =
      typeof currentTime === 'number' && !Number.isNaN(currentTime)
        ? Math.max(0, currentTime)
        : getEffectiveCurrentTime(room.playback);

    if (action === 'play') {
      room.playback.status = 'playing';
      room.playback.currentTime = numericTime;
      room.playback.updatedAt = Date.now();
    } else if (action === 'pause') {
      room.playback.status = 'paused';
      room.playback.currentTime = numericTime;
      room.playback.updatedAt = Date.now();
    } else if (action === 'seek') {
      room.playback.currentTime = numericTime;
      room.playback.updatedAt = Date.now();
    }

    if (typeof playbackRate === 'number' && playbackRate > 0) {
      room.playback.playbackRate = playbackRate;
    }

    io.to(room.id).emit('playback_sync', {
      action,
      status: room.playback.status,
      currentTime: room.playback.currentTime,
      playbackRate: room.playback.playbackRate,
      actorName: participant ? participant.name : 'Anfitrião',
      serverTimestamp: Date.now()
    });
  });

  socket.on('host_time_heartbeat', ({ currentTime, status }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (room.hostSocketId !== socket.id) return;

    if (typeof currentTime === 'number' && !Number.isNaN(currentTime)) {
      room.playback.currentTime = currentTime;
      room.playback.status = status === 'playing' ? 'playing' : 'paused';
      room.playback.updatedAt = Date.now();

      socket.to(room.id).emit('playback_heartbeat', {
        status: room.playback.status,
        currentTime: room.playback.currentTime,
        playbackRate: room.playback.playbackRate,
        serverTimestamp: Date.now()
      });
    }
  });

  socket.on('trigger_clapperboard', ({ targetTime = 0 }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!canControlRoom(room, socket.id)) return;

    const participant = room.participants.get(socket.id);
    room.playback.status = 'playing';
    room.playback.currentTime = Number(targetTime) || 0;
    room.playback.updatedAt = Date.now() + 3500;

    addSystemMessage(
      room,
      `🎬 Claquete acionada por ${participant ? participant.name : 'Anfitrião'}! Início sincronizado em 3, 2, 1...`
    );

    io.to(room.id).emit('clapperboard_countdown', {
      targetTime: room.playback.currentTime,
      actorName: participant ? participant.name : 'Anfitrião'
    });
  });

  socket.on('toggle_room_setting', ({ setting }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (room.hostSocketId !== socket.id) return;

    if (setting === 'lights') {
      room.lightsOff = !room.lightsOff;
      addSystemMessage(
        room,
        room.lightsOff ? '💡 As luzes da sala foram apagadas. Bom filme!' : '💡 As luzes da sala foram acesas.'
      );
    } else if (setting === 'freeControl') {
      room.freeControl = !room.freeControl;
      addSystemMessage(
        room,
        room.freeControl
          ? '🎮 Controle livre ativado: qualquer amigo na sala pode pausar ou dar play.'
          : '👑 Controle exclusivo do Anfitrião ativado.'
      );
    }

    io.to(room.id).emit('room_state', serializeRoom(room));
  });

  socket.on('transfer_host', ({ targetSocketId }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (room.hostSocketId !== socket.id) return;
    if (!room.participants.has(targetSocketId)) return;

    room.hostSocketId = targetSocketId;
    const newHost = room.participants.get(targetSocketId);
    addSystemMessage(room, `👑 ${newHost.name} agora é o Anfitrião da sessão!`);
    io.to(room.id).emit('room_state', serializeRoom(room));
  });

  socket.on('send_chat', ({ text }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const participant = room.participants.get(socket.id);
    if (!participant || !text || !String(text).trim()) return;

    const seatLabel = participant.seatIndex < 6 ? `A${participant.seatIndex + 1}` : `B${participant.seatIndex - 5}`;
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'user',
      socketId: socket.id,
      userName: participant.name,
      avatar: participant.avatar,
      seatLabel,
      text: String(text).trim().slice(0, 400),
      timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    room.chatHistory.push(msg);
    if (room.chatHistory.length > 80) room.chatHistory.shift();
    io.to(room.id).emit('chat_message', msg);
  });

  socket.on('send_reaction', ({ emoji }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const participant = room.participants.get(socket.id);
    if (!participant) return;

    io.to(room.id).emit('seat_reaction', {
      socketId: socket.id,
      userName: participant.name,
      seatIndex: participant.seatIndex,
      emoji: emoji || '🍿'
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const participant = room.participants.get(socket.id);

    if (participant) {
      if (participant.seatIndex >= 0 && participant.seatIndex < MAX_SEATS) {
        room.seats[participant.seatIndex] = null;
      }
      room.participants.delete(socket.id);
      addSystemMessage(room, `${participant.avatar} ${participant.name} saiu da sala.`);
    }

    if (room.participants.size === 0) {
      rooms.delete(currentRoomId);
    } else {
      if (room.hostSocketId === socket.id) {
        const nextHost = room.participants.keys().next().value;
        room.hostSocketId = nextHost;
        const promoted = room.participants.get(nextHost);
        if (promoted) {
          addSystemMessage(room, `👑 ${promoted.name} assumiu o controle como novo Anfitrião.`);
        }
      }
      io.to(room.id).emit('room_state', serializeRoom(room));
    }
  });
});

if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`\n🍿 CINE-POMPEIA (Google Drive Edition) rodando em http://localhost:${PORT}`);
    logStructured('DRIVE_SYNC', 'scheduler_initialized', {
      officialFolderId: OFFICIAL_DRIVE_FOLDER_ID,
      intervalMs: DRIVE_SYNC_INTERVAL_MS
    });

    // Sincronização automática inicial com a pasta oficial do Google Drive (FASE 3)
    setTimeout(() => {
      runAutomaticDriveFolderSync('startup')
        .then(() => {
          setTimeout(() => scheduleIdleCatalogWarmup(), 1500);
        })
        .catch(() => {});
    }, 1200);

    // Agendador periódico automático (sem necessidade de clicar em "Sincronizar Pasta")
    setInterval(() => {
      runAutomaticDriveFolderSync('scheduler').catch(() => {});
    }, DRIVE_SYNC_INTERVAL_MS);
  });
}

module.exports = app;
