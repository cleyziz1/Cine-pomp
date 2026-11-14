require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { Server } = require('socket.io');

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
// FASE 5 — INSPEÇÃO REAL DE CODECS DE ÁUDIO/VÍDEO E PREPARAÇÃO DE ÁUDIO AAC
// ============================================================================
function getPreparedMp4Path(fileId) {
  if (!isValidDriveFileId(fileId)) return null;
  const candidate = path.join(PREPARED_MEDIA_DIR, `${fileId}.mp4`);
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1024) {
      return candidate;
    }
  } catch (_) {}
  return null;
}

async function probeMediaCodecs(fileId) {
  if (codecProbeCache.has(fileId)) {
    return codecProbeCache.get(fileId);
  }

  const meta = await getDriveFileMetadata(fileId);
  if (meta.errorStatus) {
    return { errorStatus: meta.errorStatus, error: meta.error };
  }

  const preparedPath = getPreparedMp4Path(fileId);
  const fileName = meta.name || `${fileId}.mp4`;
  const lowerName = fileName.toLowerCase();

  let headerBuf = Buffer.alloc(0);
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
      const ab = await r.arrayBuffer();
      headerBuf = Buffer.from(ab);
    }
  } catch (_) {}

  const ascii = headerBuf.toString('latin1');

  // Identifica o contêiner real pelos magic bytes + nome do arquivo
  let container = 'mp4';
  if (headerBuf.length >= 4 && headerBuf[0] === 0x1a && headerBuf[1] === 0x45 && headerBuf[2] === 0xdf && headerBuf[3] === 0xa3) {
    container = ascii.toLowerCase().includes('webm') || lowerName.endsWith('.webm') ? 'webm' : 'mkv';
  } else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') {
    container = 'avi';
  } else if (ascii.slice(4, 8) === 'ftyp' || lowerName.endsWith('.mp4') || lowerName.endsWith('.m4v')) {
    container = 'mp4';
  } else if (lowerName.endsWith('.mkv')) {
    container = 'mkv';
  } else if (lowerName.endsWith('.webm')) {
    container = 'webm';
  } else if (lowerName.endsWith('.avi')) {
    container = 'avi';
  }

  // Identifica codecs de vídeo reais no cabeçalho binário
  const videoCodecs = [];
  if (ascii.includes('V_MPEG4/ISO/AVC') || ascii.includes('avc1') || ascii.includes('avc3') || /\bh\.?264|x264\b/i.test(fileName)) {
    videoCodecs.push('H.264 (AVC)');
  }
  if (ascii.includes('V_MPEGH/ISO/HEVC') || ascii.includes('hev1') || ascii.includes('hvc1') || /\bh\.?265|x265|hevc\b/i.test(fileName)) {
    videoCodecs.push('H.265 (HEVC)');
  }
  if (ascii.includes('V_VP9') || ascii.includes('vp09')) {
    videoCodecs.push('VP9');
  }
  if (ascii.includes('V_VP8') || ascii.includes('vp08')) {
    videoCodecs.push('VP8');
  }
  if (ascii.includes('V_AV1') || ascii.includes('av01')) {
    videoCodecs.push('AV1');
  }
  if (container === 'avi' && videoCodecs.length === 0) {
    videoCodecs.push('MPEG-4 Visual (AVI/Xvid)');
  }
  if (videoCodecs.length === 0) {
    videoCodecs.push('H.264 (AVC)');
  }

  // Identifica codecs de áudio reais no cabeçalho binário (MP4 boxes e Matroska EBML CodecIDs)
  const audioCodecs = [];
  let aacCount = 0;
  let ac3Count = 0;
  let eac3Count = 0;
  let dtsCount = 0;
  let opusCount = 0;
  let vorbisCount = 0;
  let mp3Count = 0;

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

  aacCount = countOccurrences(ascii, 'A_AAC') + countOccurrences(ascii, 'mp4a');
  ac3Count = countOccurrences(ascii, 'A_AC3') + countOccurrences(ascii, 'ac-3');
  eac3Count = countOccurrences(ascii, 'A_EAC3') + countOccurrences(ascii, 'ec-3');
  dtsCount = countOccurrences(ascii, 'A_DTS') + countOccurrences(ascii, 'dtsc') + countOccurrences(ascii, 'dtsh');
  opusCount = countOccurrences(ascii, 'A_OPUS') + countOccurrences(ascii, 'Opus');
  vorbisCount = countOccurrences(ascii, 'A_VORBIS');
  mp3Count = countOccurrences(ascii, 'A_MPEG/L3') + countOccurrences(ascii, '.mp3');

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

  // Detecta múltiplas faixas de áudio / idiomas (DUAL Audio: PT-BR / EN)
  const rawTrackCount = Math.max(
    1,
    aacCount + ac3Count + eac3Count + dtsCount + opusCount + vorbisCount + mp3Count
  );
  const isDualByName = /\b(dual|dublado|multi)\b/i.test(fileName);
  const detectedLanguages = [];
  if (ascii.includes('por') || /\b(pt-?br|dublado|dual|portugues)\b/i.test(fileName)) {
    detectedLanguages.push({ code: 'pt-BR', label: 'Português (Brasil)' });
  }
  if (ascii.includes('eng') || isDualByName) {
    detectedLanguages.push({ code: 'en', label: 'Inglês (Original)' });
  }
  if (detectedLanguages.length === 0) {
    detectedLanguages.push({ code: 'pt-BR', label: 'Áudio Principal' });
  }

  const hasBrowserCompatibleAudioTrack =
    container !== 'avi' &&
    (audioCodecs.includes('AAC') ||
      audioCodecs.includes('Opus') ||
      audioCodecs.includes('Vorbis') ||
      audioCodecs.includes('Opus/Vorbis') ||
      audioCodecs.includes('MP3'));

  const hasUnsupportedSurroundOnly =
    !hasBrowserCompatibleAudioTrack &&
    (audioCodecs.some((c) => c.includes('AC-3') || c.includes('DTS')) || container === 'avi');

  // Verifica posição do átomo moov em MP4
  let fastStartMoov = null;
  if (container === 'mp4') {
    const moovIdx = ascii.indexOf('moov');
    const mdatIdx = ascii.indexOf('mdat');
    fastStartMoov = moovIdx !== -1 && (mdatIdx === -1 || moovIdx < mdatIdx);
  }

  const diagnostic = {
    fileId,
    fileName,
    size: meta.size,
    container,
    videoCodecs,
    audioCodecs,
    audioTrackCount: isDualByName ? Math.max(2, rawTrackCount) : rawTrackCount,
    isDualAudio: isDualByName || rawTrackCount > 1,
    languages: detectedLanguages,
    fastStartMoov,
    browserVideoSupported: container !== 'avi' && !videoCodecs.includes('H.265 (HEVC)'),
    browserAudioSupported: Boolean(preparedPath) || hasBrowserCompatibleAudioTrack,
    hasPreparedCompatibleStream: Boolean(preparedPath),
    requiresAudioFallbackOrRemux: !preparedPath && hasUnsupportedSurroundOnly,
    diagnosticReason: preparedPath
      ? 'Versão MP4 (H.264 + AAC Estéreo) otimizada pronta no servidor.'
      : hasBrowserCompatibleAudioTrack
      ? `Áudio ${audioCodecs.join(' / ')} compatível nativamente com navegadores HTML5.`
      : container === 'avi'
      ? 'Contêiner AVI legado não é suportado nativamente pela tag <video> HTML5.'
      : `O arquivo utiliza áudio ${audioCodecs.join(', ')} em contêiner ${container.toUpperCase()}. Navegadores web reproduzem o vídeo H.264, mas não decodificam Dolby AC-3/DTS nativamente sem remux para AAC ou player com decodificador interno.`
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

// Verifica disponibilidade do FFmpeg no host para preparação/remux de áudio AAC sem tocar no arquivo original do Drive
function checkFfmpegAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

app.post('/api/videos/:id/prepare-audio', requireAdmin, async (req, res) => {
  const fileId = req.params.id;
  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ error: 'ID de arquivo inválido.' });
  }

  const existingPrepared = getPreparedMp4Path(fileId);
  if (existingPrepared) {
    return res.json({
      success: true,
      status: 'ready',
      streamUrl: `/api/videos/${fileId}/stream`,
      message: 'Versão compatível (MP4 H.264 + AAC-LC Estéreo) já está preparada.'
    });
  }

  const hasFfmpeg = await checkFfmpegAvailable();
  if (!hasFfmpeg) {
    const diag = await probeMediaCodecs(fileId);
    return res.status(200).json({
      success: true,
      status: 'fallback_drive_transcode',
      ffmpegAvailable: false,
      diagnostics: diag,
      recommendedCommand: `ffmpeg -i "https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k -ac 2 -movflags +faststart prepared_media/${fileId}.mp4`,
      message:
        'FFmpeg não detectado neste servidor. O player utilizará automaticamente o fluxo transcodificado compatível quando necessário.'
    });
  }

  try {
    fs.mkdirSync(PREPARED_MEDIA_DIR, { recursive: true });
    const outPath = path.join(PREPARED_MEDIA_DIR, `${fileId}.mp4`);
    const sourceUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
      fileId
    )}&export=download&confirm=t`;

    const ff = spawn('ffmpeg', [
      '-y',
      '-i',
      sourceUrl,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      outPath
    ]);

    ff.on('close', (code) => {
      if (code === 0) {
        codecProbeCache.delete(fileId);
        console.log(`[Audio Remux] Arquivo ${fileId} preparado com sucesso em ${outPath}`);
      }
    });

    res.json({
      success: true,
      status: 'processing',
      ffmpegAvailable: true,
      message: 'Conversão da faixa de áudio para AAC-LC iniciada em segundo plano (vídeo H.264 copiado sem perda).'
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao iniciar preparação de áudio: ' + err.message });
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

  if (!isValidDriveFileId(fileId)) {
    return res.status(400).json({ error: 'ID de arquivo inválido.' });
  }

  // Garante que apenas arquivos cadastrados no catálogo autorizado (ou com permissão explícita) sejam transmitidos
  if (!isFileAuthorizedInCatalog(fileId) && !process.env.ALLOW_UNLISTED_DRIVE_IDS) {
    console.warn(`[Stream Auth] Bloqueado acesso a arquivo não autorizado no catálogo: ${fileId}`);
    return res.status(403).json({ error: 'Arquivo não autorizado neste catálogo.' });
  }

  // Se houver versão MP4 com áudio AAC preparada localmente em prepared_media/<fileId>.mp4, serve com suporte a HTTP 206 Range
  const preparedMp4 = getPreparedMp4Path(fileId);
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
    const MAX_CHUNK_BYTES = process.env.VERCEL ? 2 * 1024 * 1024 : 4 * 1024 * 1024;
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

    console.log(`[Stream] fileId=${fileId} range=${start}-${end}/${totalSize} source=${meta.source}`);

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
