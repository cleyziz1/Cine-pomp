require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
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
// BANCO DE DADOS DO CATÁLOGO GOOGLE DRIVE (drive_catalog.json)
// ==========================================
const DRIVE_CATALOG_FILE = path.join(__dirname, 'drive_catalog.json');

// Catálogo inicial de exemplo (o usuário pode excluir ou substituir pelos vídeos do Drive de 5TB dele)
const DEFAULT_DRIVE_CATALOG = {
  folders: [],
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
  const mergedMoviesMap = new Map();
  const mergedFoldersMap = new Map();

  for (const file of [DRIVE_CATALOG_FILE, TMP_CATALOG_FILE]) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.movies)) {
          for (const m of parsed.movies) {
            if (m && m.id) mergedMoviesMap.set(m.id, m);
          }
        }
        if (parsed && Array.isArray(parsed.folders)) {
          for (const f of parsed.folders) {
            if (f && f.folderId) mergedFoldersMap.set(f.folderId, f);
          }
        }
      }
    } catch (_) {}
  }

  if (mergedMoviesMap.size > 0) {
    return {
      folders: Array.from(mergedFoldersMap.values()),
      movies: Array.from(mergedMoviesMap.values())
    };
  }
  return DEFAULT_DRIVE_CATALOG;
}

function saveDriveCatalog(catalog) {
  const json = JSON.stringify(catalog, null, 2);
  try {
    fs.writeFileSync(DRIVE_CATALOG_FILE, json, 'utf8');
  } catch (_) {
    try {
      fs.writeFileSync(TMP_CATALOG_FILE, json, 'utf8');
    } catch (__) {}
  }
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
  const { query = '', category = 'all' } = req.query;
  const q = String(query).toLowerCase().trim();

  let movies = [...driveCatalog.movies].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

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
    totalMovies: driveCatalog.movies.length,
    folders: driveCatalog.folders || [],
    hero,
    movies,
    rows
  });
});

// Auto-preenchimento de Capa e Sinopse quando o usuário digita o nome do filme que subiu no Drive
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

// Adicionar ou editar um Filme do Google Drive
app.post('/api/drive/movies', async (req, res) => {
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

    // Se o usuário não colou capa manualmente, busca a capa/sinopse automaticamente pelo nome do filme
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
      id: id || `drive_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

    // Se já existia com mesmo ID, atualiza; senão adiciona no início
    const existingIdx = driveCatalog.movies.findIndex((m) => m.id === movieObj.id);
    if (existingIdx >= 0) {
      driveCatalog.movies[existingIdx] = movieObj;
    } else {
      driveCatalog.movies.unshift(movieObj);
    }

    saveDriveCatalog(driveCatalog);
    res.json({ success: true, movie: movieObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remover um filme do catálogo do Drive
app.delete('/api/drive/movies/:id', (req, res) => {
  const { id } = req.params;
  driveCatalog.movies = driveCatalog.movies.filter((m) => m.id !== id);
  saveDriveCatalog(driveCatalog);
  res.json({ success: true });
});

// Sincronizar uma PASTA INTEIRA compartilhada do Google Drive!
app.post('/api/drive/sync-folder', async (req, res) => {
  try {
    const { folderUrl, defaultCategory = 'Auto' } = req.body;
    const folderId = extractDriveFolderId(folderUrl);

    if (!folderId) {
      return res.status(400).json({
        error: 'Link de pasta inválido. Cole um link do tipo: https://drive.google.com/drive/folders/ID_DA_PASTA'
      });
    }

    // Usa a visualização pública oficial do Google Drive para listar os arquivos da pasta compartilhada
    const embedListUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
    const response = await fetch(embedListUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return res.status(400).json({
        error: 'Não foi possível ler a pasta. Verifique se ela está compartilhada como "Qualquer pessoa com o link pode ver".'
      });
    }

    const html = await response.text();
    // Extrai cada <div class="flip-entry" id="entry-FILE_ID"> ... <div class="flip-entry-title">FILENAME</div>
    const entryRegex = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
    const discoveredFiles = [];
    let match;
    while ((match = entryRegex.exec(html)) !== null) {
      const fileId = match[1];
      const fileName = match[2].trim();
      // Filtra arquivos de vídeo (ou qualquer arquivo que não seja imagem/texto óbvio)
      if (!/\.(jpg|jpeg|png|gif|srt|vtt|txt|nfo|pdf|zip|rar)$/i.test(fileName)) {
        discoveredFiles.push({ fileId, fileName });
      }
    }

    if (discoveredFiles.length === 0) {
      return res.status(400).json({
        error: 'Nenhum arquivo de vídeo foi encontrado dentro desta pasta do Google Drive (certifique-se de que a pasta está pública e contém vídeos).'
      });
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

    // Registra a pasta sincronizada
    if (!driveCatalog.folders.some((f) => f.folderId === folderId)) {
      driveCatalog.folders.push({
        folderId,
        folderUrl,
        syncedAt: new Date().toLocaleString('pt-BR')
      });
    }

    saveDriveCatalog(driveCatalog);
    res.json({
      success: true,
      discoveredCount: discoveredFiles.length,
      addedCount,
      totalMovies: driveCatalog.movies.length,
      movies: driveCatalog.movies
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao sincronizar pasta do Drive: ' + err.message });
  }
});

// ============================================================================
// INTEGRAÇÃO GOOGLE DRIVE API v3 + STREAMING HTTP 206 COM PIPE E BACKPRESSURE
// ============================================================================
const driveMetaCache = new Map();
const META_CACHE_TTL_MS = 10 * 60 * 1000;

function isValidDriveFileId(fileId) {
  return /^[a-zA-Z0-9_-]{20,60}$/.test(String(fileId || '').trim());
}

function isFileAuthorizedInCatalog(fileId) {
  if (!isValidDriveFileId(fileId)) return false;
  if (driveCatalog && Array.isArray(driveCatalog.movies)) {
    if (driveCatalog.movies.some((m) => m.driveFileId === fileId)) return true;
  }
  return false;
}

function inferMimeType(nameOrDisposition, apiMimeType) {
  if (apiMimeType && apiMimeType.startsWith('video/')) {
    // Chrome/Edge reproduzem H.264/AAC dentro de MKV melhor quando servido como video/mp4 ou video/x-matroska
    if (apiMimeType === 'video/x-matroska') return 'video/mp4';
    return apiMimeType;
  }
  const str = String(nameOrDisposition || '').toLowerCase();
  if (str.includes('.webm')) return 'video/webm';
  if (str.includes('.ogg') || str.includes('.ogv')) return 'video/ogg';
  return 'video/mp4';
}

async function getDriveFileMetadata(fileId) {
  const cached = driveMetaCache.get(fileId);
  if (cached && Date.now() - cached.cachedAt < META_CACHE_TTL_MS) {
    return cached.meta;
  }

  const googleApiKey = (process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  const googleOAuthToken = (process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim();

  // 1. Tenta Google Drive API v3 oficial quando credenciais estiverem configuradas no backend
  if (googleApiKey || googleOAuthToken) {
    try {
      const apiUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      apiUrl.searchParams.set('fields', 'id,name,mimeType,size,capabilities(canDownload)');
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
        const canDownload = data.capabilities ? data.capabilities.canDownload !== false : true;
        const meta = {
          id: data.id,
          name: data.name || `${fileId}.mp4`,
          mimeType: inferMimeType(data.name, data.mimeType),
          size: Number(data.size || 0),
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

  // 2. Fallback seguro via HEAD com Range delimitado (para arquivos públicos compartilhados sem OAuth no .env)
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
    driveMetaCache.set(fileId, { meta, cachedAt: Date.now() });
    return meta;
  } catch (err) {
    return { errorStatus: 502, error: 'Falha ao consultar arquivo no Google Drive: ' + err.message };
  }
}

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
    // Blocos limitados para streaming progressivo com baixo consumo de RAM e compatibilidade Serverless/Drive
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
        // Suffix byte range: bytes=-500
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

    if (!upstream.body) {
      return res.status(502).end();
    }

    // Streaming progressivo com backpressure nativo via Node Stream (sem carregar o arquivo na RAM)
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
