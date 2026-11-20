// ============================================================================
// CINE POMPEIA — MÓDULO COMPARTILHADO (ESM puro, zero dependências)
// Compartilhado entre src/worker.js (Cloudflare Workers) e server.js (Node.js)
// ============================================================================

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
});

export function isAllowedCorsOrigin(origin, extraOriginsCsv = '') {
  if (!origin) return false;
  const clean = String(origin).trim().toLowerCase();
  if (
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean) ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(clean) ||
    /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(clean)
  ) {
    return true;
  }
  if (extraOriginsCsv) {
    const extras = String(extraOriginsCsv)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (extras.includes(clean)) return true;
  }
  return false;
}

export function buildCorsHeaders(origin, extraOriginsCsv = '') {
  if (!isAllowedCorsOrigin(origin, extraOriginsCsv)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, If-None-Match, X-Request-Id',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag, X-Request-Id, Content-Disposition',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

export function generateRequestId() {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function constantTimeEqual(a, b) {
  const strA = String(a || '');
  const strB = String(b || '');
  const len = Math.max(strA.length, strB.length);
  let diff = strA.length ^ strB.length;
  for (let i = 0; i < len; i++) {
    const ca = i < strA.length ? strA.charCodeAt(i) : 0;
    const cb = i < strB.length ? strB.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export function isValidDriveFileId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{10,80}$/.test(id.trim());
}

export function extractDriveFileId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^[a-zA-Z0-9_-]{15,60}$/.test(trimmed)) return trimmed;
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/open\?id=([a-zA-Z0-9_-]+)/
  ];
  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match && match[1]) return match[1];
  }
  return null;
}

export function extractDriveFolderId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^[a-zA-Z0-9_-]{15,60}$/.test(trimmed)) return trimmed;
  const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/];
  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match && match[1]) return match[1];
  }
  return null;
}

export function getStreamMimeType(apiMimeType, nameOrDisposition = '') {
  if (apiMimeType && apiMimeType.startsWith('video/')) {
    if (apiMimeType === 'video/x-matroska') return 'video/mp4';
    return apiMimeType;
  }
  const str = String(nameOrDisposition || '').toLowerCase();
  if (str.includes('.webm')) return 'video/webm';
  if (str.includes('.ogg') || str.includes('.ogv')) return 'video/ogg';
  return 'video/mp4';
}

/**
 * Parser estrito de HTTP Range (RFC 9110) para streaming 206/416.
 * Retorna { ok: true, start, end, chunkLen, isPartial } ou { ok: false, status: 416 }.
 */
export function parseHttpByteRange(rangeHeader, totalSize, maxChunkBytes = 8 * 1024 * 1024) {
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    return { ok: false, status: 416 };
  }
  if (!rangeHeader) {
    const end = Math.min(maxChunkBytes - 1, totalSize - 1);
    return { ok: true, start: 0, end, chunkLen: end + 1, isPartial: false };
  }

  const match = String(rangeHeader).trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { ok: false, status: 416 };

  let start = 0;
  let end = totalSize - 1;

  if (match[1] === '' && match[2] !== '') {
    const suffixLen = parseInt(match[2], 10);
    if (Number.isNaN(suffixLen) || suffixLen <= 0) return { ok: false, status: 416 };
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else if (match[1] !== '') {
    start = parseInt(match[1], 10);
    const requestedEnd = match[2] !== '' ? parseInt(match[2], 10) : totalSize - 1;
    if (
      Number.isNaN(start) ||
      Number.isNaN(requestedEnd) ||
      start < 0 ||
      start >= totalSize ||
      requestedEnd < start
    ) {
      return { ok: false, status: 416 };
    }
    end = Math.min(requestedEnd, start + maxChunkBytes - 1, totalSize - 1);
  } else {
    return { ok: false, status: 416 };
  }

  return { ok: true, start, end, chunkLen: end - start + 1, isPartial: true };
}

/**
 * Mascara TODAS as faixas de áudio incompatíveis com navegadores (A_AC3, A_EAC3, A_DTS)
 * no cabeçalho EBML de arquivos Matroska/MKV, alterando apenas 1 byte do TrackType
 * (0x83 0x81 0x02 -> 0x83 0x81 0x20), mantendo exatamente o mesmo tamanho em bytes e offsets de Range.
 * Preserva intactas faixas compatíveis (A_AAC, A_OPUS, A_MPEG/L3, V_MPEG4/ISO/AVC).
 */
export function patchEbmlHeaderForUnsupportedAudio(inputBytes) {
  if (!inputBytes || inputBytes.byteLength < 64) return inputBytes;
  const view = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);

  // Assinatura EBML (0x1A 0x45 0xDF 0xA3)
  if (view[0] !== 0x1a || view[1] !== 0x45 || view[2] !== 0xdf || view[3] !== 0xa3) {
    return inputBytes;
  }

  const scanLen = Math.min(view.byteLength, 32768);
  let headerAscii = '';
  for (let i = 0; i < scanLen; i += 4096) {
    headerAscii += String.fromCharCode.apply(null, view.subarray(i, Math.min(scanLen, i + 4096)));
  }

  // Mascara SEMPRE A_EAC3 e A_DTS (evita travamento do demuxer Chromium em MKV E-AC-3 sem A_AAC, ex: Guerra Civil)
  // e mascara A_AC3 apenas quando A_AAC coexiste (Dual-Audio MKV, preservando demuxing rápido em MKVs AC-3 puros como Harry Potter 3).
  const hasAac = headerAscii.includes('A_AAC');
  const unsupportedTokens = hasAac ? ['A_AC3', 'A_EAC3', 'A_DTS'] : ['A_EAC3', 'A_DTS'];
  const codecPositions = [];
  for (const token of unsupportedTokens) {
    let from = 0;
    while (from < headerAscii.length) {
      const pos = headerAscii.indexOf(token, from);
      if (pos === -1) break;
      codecPositions.push(pos);
      from = pos + token.length;
    }
  }
  if (codecPositions.length === 0) return inputBytes;

  const isNodeBuffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(inputBytes);
  const patched = isNodeBuffer ? Buffer.from(inputBytes) : new Uint8Array(view);
  for (const targetCodecPos of codecPositions) {
    const trackEntryStart = Math.max(0, headerAscii.lastIndexOf('\xae', targetCodecPos));
    for (let i = trackEntryStart; i < targetCodecPos; i++) {
      if (patched[i] === 0x83 && patched[i + 1] === 0x81 && patched[i + 2] === 0x02) {
        patched[i + 2] = 0x20;
        break;
      }
    }
  }
  return patched;
}

export function parseMovieFilename(filename) {
  let clean = String(filename || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
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

  clean = clean
    .replace(/\(\s*(19\d{2}|20\d{2})\s*\)/g, ' ')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(
      /\b(1080p|720p|480p|2160p|4k|uhd|hdr|remastered|bluray|blu-ray|brrip|bdrip|web-dl|webdl|webrip|hdrip|dvdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|dd5|ddp5|5\.1|6ch|2ch|dts|dual|dublado|legendado|nacional|pt-br|ptbr|multi|totti9|210gji|wolverdonfilmes|comandotorrents|tdf|sf|com)\b/gi,
      ' '
    )
    .replace(/\s*[-–—]\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title: clean || String(filename || 'Filme').trim(), year };
}

export function computeTitleSimilarity(a, b) {
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
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = new Set(na.split(' ').filter((w) => w.length > 1));
  const wb = new Set(nb.split(' ').filter((w) => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let hits = 0;
  for (const w of wa) if (wb.has(w)) hits++;
  return hits / Math.max(wa.size, wb.size);
}
