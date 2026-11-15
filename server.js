require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { Server } = require('socket.io');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_SEATS = 12;

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

app.post('/api/auth/login', (req, res) => {
  const password = String((req.body && req.body.password) || '').trim();
  if (!password) {
    return res.status(400).json({ error: 'Informe a senha de administrador.' });
  }
  const passBuf = Buffer.from(password);
  const adminBuf = Buffer.from(ADMIN_PASSWORD);
  if (passBuf.length !== adminBuf.length || !crypto.timingSafeEqual(passBuf, adminBuf)) {
    console.warn('[RBAC Auth] Falha de login administrativo (senha incorreta).');
    return res.status(401).json({ error: 'Senha de administrador incorreta.' });
  }
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

function loadDriveCatalog() {
  for (const file of [DRIVE_CATALOG_FILE, TMP_CATALOG_FILE]) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.movies)) {
          return {
            folders: Array.isArray(parsed.folders) ? parsed.folders : [],
            removedMovies: Array.isArray(parsed.removedMovies) ? parsed.removedMovies : [],
            driveChangesPageToken: parsed.driveChangesPageToken || null,
            lastReconciledAt: parsed.lastReconciledAt || null,
            movies: parsed.movies.filter((m) => m && m.id)
          };
        }
      }
    } catch (_) {}
  }
  return DEFAULT_DRIVE_CATALOG;
}

function saveDriveCatalog(catalog) {
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
    .replace(/[._]/g, ' ')
    .replace(/^\s*\d{1,3}\s*[-.]\s*/, '');

  const yearMatch = clean.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : '';

  // Remove tags técnicas comuns após o ano ou no final
  clean = clean
    .replace(/\b(open\s*matte|imax|remastered|1080p|720p|2160p|4k|blu-?ray|web-?dl|webrip|hdrip|x264|x265|h264|h265|hevc|aac|ac3|dual|dublado|legendado|pt-?br|5\.1|brshares)\b.*/i, '')
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

// Busca opcional de capa/sinopse automática pelo título para deixar o Google Drive lindo como um Streaming
async function fetchMetadataByTitle(title, year) {
  const tmdbKey = (process.env.TMDB_API_KEY || '').trim();
  if (!tmdbKey || !title) return null;

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
    if (!res.ok) return null;
    const data = await res.json();
    const hit = (data.results || []).find((r) => r.media_type === 'movie' || r.media_type === 'tv') || (data.results || [])[0];
    if (!hit) return null;

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

    return {
      title: hit.title || hit.name || title,
      year: (hit.release_date || hit.first_air_date || year || '').slice(0, 4),
      rating: hit.vote_average ? hit.vote_average.toFixed(1) : '8.5',
      category,
      poster: hit.poster_path
        ? `https://image.tmdb.org/t/p/w500${hit.poster_path}`
        : null,
      backdrop: hit.backdrop_path
        ? `https://image.tmdb.org/t/p/original${hit.backdrop_path}`
        : null,
      overview: hit.overview || ''
    };
  } catch (_) {
    return null;
  }
}

// ==========================================
// ROTAS DO CATÁLOGO DE STREAMING DO GOOGLE DRIVE
// ==========================================

// Retorna o catálogo organizado em fileiras estilo Netflix/Prime Video
app.get('/api/drive/catalog', (req, res) => {
  const { query = '', category = 'all', includeUnavailable = 'false' } = req.query;
  const q = String(query).toLowerCase().trim();
  const isAdmin = isRequestAdmin(req);

  let movies = [...driveCatalog.movies]
    .filter((m) => (isAdmin && includeUnavailable === 'true' ? true : !m.unavailable && !m.trashed))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

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

// Lista arquivos de uma pasta do Google Drive via API v3 ou embeddedfolderview
async function fetchDriveFolderFiles(folderId) {
  const googleApiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  const googleOAuthToken = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();

  if (googleApiKey || googleOAuthToken) {
    try {
      const apiUrl = new URL('https://www.googleapis.com/drive/v3/files');
      apiUrl.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
      apiUrl.searchParams.set('fields', 'files(id,name,mimeType,size,trashed)');
      apiUrl.searchParams.set('pageSize', '200');
      apiUrl.searchParams.set('supportsAllDrives', 'true');
      apiUrl.searchParams.set('includeItemsFromAllDrives', 'true');
      if (googleApiKey && !googleOAuthToken) apiUrl.searchParams.set('key', googleApiKey);

      const headers = {};
      if (googleOAuthToken) headers.Authorization = `Bearer ${googleOAuthToken}`;

      const apiRes = await fetch(apiUrl.toString(), { headers });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const files = (data.files || [])
          .filter((f) => !f.trashed && !/\.(jpg|jpeg|png|gif|srt|vtt|txt|nfo|pdf|zip|rar)$/i.test(f.name || ''))
          .map((f) => ({ fileId: f.id, fileName: f.name }));
        return { ok: true, status: 200, source: 'drive_api_v3', files };
      }
      if (apiRes.status >= 500 || apiRes.status === 429) {
        return { ok: false, temporaryError: true, status: apiRes.status, error: 'Erro temporário na Google Drive API v3.' };
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
      const fileName = match[2].trim();
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

// Sincronizar uma PASTA INTEIRA compartilhada do Google Drive (PROTEGIDO POR RBAC: APENAS ADMINISTRADOR)
app.post('/api/drive/sync-folder', requireAdmin, async (req, res) => {
  try {
    const { folderUrl, defaultCategory = 'Auto', removeMissingFromFolder = true } = req.body;
    const folderId = extractDriveFolderId(folderUrl);

    if (!folderId) {
      return res.status(400).json({
        error: 'Link de pasta inválido. Cole um link do tipo: https://drive.google.com/drive/folders/ID_DA_PASTA'
      });
    }

    const folderResult = await fetchDriveFolderFiles(folderId);
    if (!folderResult.ok) {
      return res.status(folderResult.temporaryError ? 503 : 400).json({
        error: folderResult.error
      });
    }

    const discoveredFiles = folderResult.files;
    if (discoveredFiles.length === 0) {
      return res.status(400).json({
        error: 'Nenhum arquivo de vídeo foi encontrado dentro desta pasta do Google Drive (certifique-se de que a pasta está pública e contém vídeos).'
      });
    }

    const discoveredIdsSet = new Set(discoveredFiles.map((f) => f.fileId));

    // Reconciliação de exclusões: se um filme da pasta sincronizada foi excluído ou movido para fora da pasta, remove do catálogo ativo
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
          driveMetaCache.delete(m.driveFileId);
          codecProbeCache.delete(m.driveFileId);
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

    // Marca folderId nos filmes existentes que pertencem a esta pasta
    for (const m of driveCatalog.movies) {
      if (m.driveFileId && discoveredIdsSet.has(m.driveFileId) && !m.folderId) {
        m.folderId = folderId;
      }
    }

    const newFiles = discoveredFiles.filter(
      (file) => !driveCatalog.movies.some((m) => m.driveFileId === file.fileId)
    );

    const createdMovies = await Promise.all(
      newFiles.map(async (file, idx) => {
        const parsed = parseMovieFilename(file.fileName);
        const meta = await fetchMetadataByTitle(parsed.title, parsed.year);

        return {
          id: `drive_${file.fileId}`,
          title: (meta && meta.title) || parsed.title,
          year: (meta && meta.year) || parsed.year,
          rating: (meta && meta.rating) || '8.5',
          category:
            defaultCategory !== 'Auto'
              ? defaultCategory
              : (meta && meta.category) || 'Filmes do Google Drive',
          featured: idx === 0,
          driveFileId: file.fileId,
          folderId,
          fileName: file.fileName,
          rawUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
          streamUrl: `/api/gdrive/stream/${file.fileId}`,
          poster:
            (meta && meta.poster) ||
            `https://placehold.co/500x750/151828/f5c518?text=${encodeURIComponent(parsed.title)}`,
          backdrop:
            (meta && meta.backdrop) ||
            (meta && meta.poster) ||
            '',
          overview:
            (meta && meta.overview) ||
            `Arquivo sincronizado da sua pasta do Google Drive (${file.fileName}).`,
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

    saveDriveCatalog(driveCatalog);
    io.emit('catalog_synced', {
      movies: driveCatalog.movies,
      removedIds: removedMoviesList.map((r) => r.id)
    });

    res.json({
      success: true,
      discoveredCount: discoveredFiles.length,
      addedCount,
      removedCount: removedMoviesList.length,
      removedMovies: removedMoviesList,
      totalMovies: driveCatalog.movies.length,
      movies: driveCatalog.movies
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sincronizar pasta do Drive: ' + err.message });
  }
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
    console.warn('[Drive Reconcile] Falha temporária simulada da API do Google Drive (503). Preservando catálogo intacto.');
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

  const removedEntries = [];
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
      console.warn(`[Drive Reconcile] Erro temporário ao ler pasta ${folder.folderId}: ${fRes.error}`);
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
      driveMetaCache.delete(movie.driveFileId);
      codecProbeCache.delete(movie.driveFileId);
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
        driveMetaCache.delete(movie.driveFileId);
        codecProbeCache.delete(movie.driveFileId);
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
        driveMetaCache.delete(movie.driveFileId);
        codecProbeCache.delete(movie.driveFileId);
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
        driveMetaCache.delete(movie.driveFileId);
        codecProbeCache.delete(movie.driveFileId);
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

  if (removedEntries.length > 0) {
    io.emit('catalog_synced', {
      movies: driveCatalog.movies,
      removedIds: removedEntries.map((r) => r.id)
    });
  }

  return {
    success: true,
    checkedCount,
    removedCount: removedEntries.length,
    removedMovies: removedEntries,
    temporaryErrors,
    totalMovies: driveCatalog.movies.length,
    lastReconciledAt: driveCatalog.lastReconciledAt,
    movies: driveCatalog.movies
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
const META_CACHE_TTL_MS = 10 * 60 * 1000;

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
      return cached.meta;
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
let mediaRegistry = { files: {} };
try {
  fs.mkdirSync(PREPARED_MEDIA_DIR, { recursive: true });
  if (fs.existsSync(MEDIA_REGISTRY_FILE)) {
    mediaRegistry = JSON.parse(fs.readFileSync(MEDIA_REGISTRY_FILE, 'utf8'));
    if (!mediaRegistry || typeof mediaRegistry.files !== 'object') {
      mediaRegistry = { files: {} };
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
    trackIdx === 0 ? path.join(PREPARED_MEDIA_DIR, `${fileId}.mp4`) : null
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

function checkFfmpegAvailable() {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

function checkFfprobeAvailable() {
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE_BIN, ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

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

  const requiresRemux = !preparedPath && !primaryTrackCompat;

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
    updatedAt: new Date().toISOString()
  };
  saveMediaRegistry();

  // Determina a URL direta de reprodução para o player personalizado (sem nunca abrir o iframe do Google Drive!)
  let recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream`;
  if (preparedPath) {
    recommendedCustomPlayerUrl = `/api/videos/${fileId}/stream?compat=1&audioTrack=0`;
  } else if (requiresRemux && hasFfmpeg) {
    recommendedCustomPlayerUrl = `/api/videos/${fileId}/hls/0/playlist.m3u8`;
  }

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
    browserAudioSupported: Boolean(preparedPath) || primaryTrackCompat,
    hasPreparedCompatibleStream: Boolean(preparedPath),
    hasPreparedCompatibleAudio: Boolean(preparedPath),
    requiresAudioFallbackOrRemux: requiresRemux,
    recommendedCustomPlayerUrl,
    diagnosticReason: preparedPath
      ? 'Versão MP4 (H.264 + AAC-LC Estéreo) pronta e armazenada no servidor.'
      : primaryTrackCompat
      ? `Áudio ${audioCodecs.join(' / ')} compatível nativamente com o Player Personalizado.`
      : `Áudio original ${audioCodecs.join(', ')} convertido automaticamente para AAC-LC Estéreo no Player Personalizado (vídeo original preservado).`
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
    const localStreamUrl = `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1`;
    const canCopyVideo = diag && diag.container !== 'avi' && !(diag.videoCodecs || []).includes('H.265 (HEVC)');
    const tmpPath = path.join(hlsDir, `seg_${segIdx}.tmp.ts`);

    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-probesize',
        '1000000',
        '-analyzeduration',
        '1500000',
        '-ss',
        String(startSec),
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

  if (!isValidDriveFileId(fileId)) {
    return res.status(400).end();
  }
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) {
    return res.status(403).end();
  }

  try {
    const diag = await probeMediaCodecs(fileId);
    const segPath = await ensureHlsSegment(fileId, trackIdx, segIdx, diag);

    // Pré-aquece o próximo segmento em segundo plano sem bloquear a resposta atual
    const totalDuration = Number(diag && diag.duration) || 7200;
    if ((segIdx + 1) * HLS_SEG_DURATION < totalDuration) {
      ensureHlsSegment(fileId, trackIdx, segIdx + 1, diag).catch(() => {});
    }

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
// FASE 3 — PREVIEW DE CENAS NA BARRA DE REPRODUÇÃO (THUMBNAILS + WEBVTT + CACHE)
// ============================================================================
const inFlightThumbnails = new Map(); // `${fileId}:${quantizedT}` -> Promise<string>
const thumbnailWarmupActive = new Set();

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

  const promise = (async () => {
    const hasFfmpeg = await checkFfmpegAvailable();
    if (!hasFfmpeg) {
      throw new Error('FFmpeg indisponível para extrair miniatura.');
    }

    const preparedMp4 = getPreparedMp4Path(fileId, 0);
    const inputSource = preparedMp4 || `http://127.0.0.1:${PORT}/api/videos/${encodeURIComponent(fileId)}/stream?raw=1`;
    const tmpPath = path.join(thumbsDir, `thumb_${tInt}.tmp.jpg`);

    return new Promise((resolve, reject) => {
      execFile(
        FFMPEG_BIN,
        [
          '-y',
          '-probesize',
          '500000',
          '-analyzeduration',
          '500000',
          '-ss',
          String(tInt),
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
        { timeout: 15000 },
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
    inFlightThumbnails.delete(lockKey);
  });

  inFlightThumbnails.set(lockKey, promise);
  return promise;
}

// Pré-aquecimento moderado de thumbnails em segundo plano sem bloquear a navegação
async function warmUpKeyThumbnails(fileId, durationSec, interval) {
  if (!durationSec || durationSec <= 0 || thumbnailWarmupActive.has(fileId)) return;
  thumbnailWarmupActive.add(fileId);
  try {
    const samplePoints = [
      0,
      interval,
      interval * 2,
      Math.floor(durationSec * 0.1 / interval) * interval,
      Math.floor(durationSec * 0.25 / interval) * interval,
      Math.floor(durationSec * 0.5 / interval) * interval,
      Math.floor(durationSec * 0.75 / interval) * interval
    ];
    for (const pt of samplePoints) {
      if (pt >= 0 && pt < durationSec) {
        await ensureThumbnailFrame(fileId, pt).catch(() => {});
      }
    }
  } finally {
    thumbnailWarmupActive.delete(fileId);
  }
}

app.get('/api/videos/:id/thumbnails/meta', async (req, res) => {
  const fileId = req.params.id;
  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ available: false, error: 'ID inválido' });
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

    // Dispara pré-aquecimento assíncrono das primeiras cenas
    if (duration > 0) {
      setImmediate(() => warmUpKeyThumbnails(fileId, duration, interval));
    }

    res.json({
      available: true,
      fileId,
      duration,
      interval,
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

async function handleVideoStreamRequest(req, res) {
  const fileId = req.params.id || req.params.fileId;
  const isRawInternal = req.query.raw === '1';
  const requestedTrack = Math.max(0, parseInt(req.query.audioTrack, 10) || 0);

  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ error: 'ID de arquivo inválido.' });
  }

  // Garante que apenas arquivos cadastrados no catálogo autorizado (ou com permissão explícita) sejam transmitidos
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) {
    console.warn(`[Stream Auth] Bloqueado acesso a arquivo não autorizado no catálogo: ${fileId}`);
    return res.status(403).json({ error: 'Arquivo não autorizado neste catálogo.' });
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
      console.warn(`[Stream Meta Error] fileId=${fileId} status=${meta.errorStatus}`);
      return res.status(meta.errorStatus).json({ error: meta.error });
    }
    if (!meta.canDownload || !meta.size) {
      return res.status(403).json({ error: 'Arquivo sem permissão de download ou tamanho indisponível.' });
    }

    const totalSize = meta.size;
    // IMPORTANTE: O Google Drive retorna página HTML se o cabeçalho Range pedir 0 até totalSize-1 (arquivo inteiro).
    // Limitamos cada fatia HTTP 206 a 16MB (para FFmpeg/FFprobe interno) ou 8MB (para navegador), garantindo sempre bytes binários 206!
    const MAX_CHUNK_BYTES = isRawInternal
      ? 16 * 1024 * 1024
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

    // Se a requisição estiver dentro do cache de extremidade final (tail_512kb.bin, ex: MKV Cues / MP4 moov no fim),
    // responde instantaneamente do disco local em < 1ms!
    const mediaDir = path.join(PREPARED_MEDIA_DIR, fileId);
    const tailPath = path.join(mediaDir, 'tail_512kb.bin');
    const TAIL_SIZE = Math.min(512 * 1024, totalSize);
    const tailStart = Math.max(0, totalSize - TAIL_SIZE);
    if (start >= tailStart && fs.existsSync(tailPath)) {
      try {
        const tailStat = fs.statSync(tailPath);
        if (tailStat.size === TAIL_SIZE) {
          const localStart = start - tailStart;
          const localEnd = Math.min(end - tailStart, TAIL_SIZE - 1);
          const chunkLen = localEnd - localStart + 1;
          res.status(206);
          res.setHeader('Content-Type', meta.mimeType);
          res.setHeader('Content-Range', `bytes ${start}-${ tailStart + localEnd }/${totalSize}`);
          res.setHeader('Content-Length', String(chunkLen));
          res.setHeader('Accept-Ranges', 'bytes');
          return fs.createReadStream(tailPath, { start: localStart, end: localEnd }).pipe(res);
        }
      } catch (_) {}
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

    if (!isRawInternal) {
      console.log(`[Stream] fileId=${fileId} range=${start}-${end}/${totalSize} source=${meta.source}`);
    }

    const upstream = await fetch(upstreamUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: abortController.signal
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error(`[Stream Upstream Error] fileId=${fileId} status=${upstream.status}`);
      return res.status(upstream.status).json({
        error: 'Falha ao obter fluxo de vídeo do Google Drive.'
      });
    }

    const upstreamType = upstream.headers.get('content-type') || '';
    if (upstreamType.includes('text/html')) {
      console.error(`[Stream HTML Blocked] fileId=${fileId} retornou text/html em vez de mídia.`);
      return res.status(403).json({
        error: 'O Google Drive retornou página de bloqueio em vez dos bytes do vídeo.'
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

app.get('/api/videos/:id/meta', handleVideoMetadataRequest);
app.get('/api/gdrive/meta/:fileId', handleVideoMetadataRequest);
app.get('/api/videos/:id/stream', handleVideoStreamRequest);
app.get('/api/gdrive/stream/:fileId', handleVideoStreamRequest);

// ==========================================
// GERENCIAMENTO DE SALAS DE CINEMA (12 POLTRONAS + WEBSOCKETS)
// ==========================================
const rooms = new Map();

function getInitialMovieForRoom() {
  const first = driveCatalog.movies[0] || DEFAULT_DRIVE_CATALOG.movies[0];
  return {
    id: first.id,
    title: first.title,
    year: first.year || 'HD',
    category: first.category || 'Google Drive',
    poster: first.poster,
    backdrop: first.backdrop || first.poster,
    overview: first.overview,
    streamUrl: first.streamUrl
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

    room.media = {
      ...room.media,
      ...newMedia
    };

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
  });
}

module.exports = app;
