// ============================================================================
// CINE POMPEIA — SERVICE WORKER DE STREAMING DIRETO DO GOOGLE DRIVE
// Faz o proxy dos blocos HTTP 206 (Range: bytes=START-END) diretamente do
// navegador do usuário para o Player Nativo HTML5 (<video>), sem depender de
// limites de banda da Vercel e usando o IP residencial do próprio usuário!
// ============================================================================

const KNOWN_DRIVE_FILES = {
  '1NamT9cBP-X-sklL8NZKuZYRiC3FFXzNJ': { size: 2926316477, ext: 'mkv' },
  '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN': { size: 4568442642, ext: 'mkv' },
  '10DYzJO7xYqUwVqyaXGtB7mtmDUf_4TlQ': { size: 2409627347, ext: 'mkv' },
  '1WVL9lFYRRomMsvAibEukp1jrj7VX6CHm': { size: 330723534, ext: 'mp4' },
  '1LMNLyic4K4EPQhVJPPmgBkOdk6c3Vgqi': { size: 6870026537, ext: 'mkv' },
  '1O8YWLCL3qy33YI3FTHKnAp7GAJrOAV3B': { size: 2302835523, ext: 'mkv' },
  '1ITsZwQ8Bmk35OQRtdpWSz8bKjk-w_Krr': { size: 3914516471, ext: 'webm' },
  '1FxU_dp2EAkrYdvg1pBXqb-kILHoUnQ5Z': { size: 707937666, ext: 'mkv' },
  '19pYQK72iWgHojbZeAJ5cjfmexFoyu4DN': { size: 765583360, ext: 'avi' },
  '17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq': { size: 2298002262, ext: 'mkv' },
  '1yZDOGrt0uDuxJMV49tKtWZLp08WPMmm6': { size: 3437458729, ext: 'webm' },
  '1WMuYuKP2UCWOrIdeN8twMuBD6DxRC5Y2': { size: 309203948, ext: 'mp4' },
  '134ZasWjMLyOFSHBcVtxNXvS_ZshNHLgH': { size: 2241510103, ext: 'mkv' },
  '1JtQCKY79dzXi4VnicZp-3w3i_j7lKaJP': { size: 4053590335, ext: 'webm' },
  '11PUCi0OoEV2hsP5iZW3E-0IPt5bKL6Ka': { size: 2681238470, ext: 'mkv' },
  '1vlQOZLfXBkACbwSg4N1x68yzfKZXA8X_': { size: 2716675369, ext: 'mkv' },
  '1sOZ4eAXNWvLH8xy76Y5PZqSvcYm9APAk': { size: 1159309072, ext: 'mp4' },
  '1Tte7oU7xlxFeAhgVKTzkWcZv1KqffGT7': { size: 2705705528, ext: 'mkv' },
  '1UPS01K81aZYh6sofmAUkwBjFYN7D09RH': { size: 2837889116, ext: 'mkv' },
  '1jHPPYUSl1HEI0KmmBxxWgXogep1jAssU': { size: 3116729579, ext: 'mkv' },
  '1iZOHBAZExihvaMAlTSkcqsxYZRqkqULV': { size: 3193328516, ext: 'webm' },
  '1f2Q4WoYpS-0A7Xwgyb881DRAOvmg7Gri': { size: 5421951266, ext: 'mkv' },
  '1TkM-Ch8w6lBDyc3DdJL1rZmdLyBwBd3e': { size: 841351737, ext: 'mp4' },
  '1R9PXGjplmt9f2kCQsQv1DzPpZJe7i3BT': { size: 3609371218, ext: 'mkv' },
  '1RFhTNE1ygeKhGa8w5ysN3Vo6UexRXYnn': { size: 606718764, ext: 'mp4' }
};

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function resolveFileMeta(fileId) {
  if (KNOWN_DRIVE_FILES[fileId]) {
    return KNOWN_DRIVE_FILES[fileId];
  }

  // 1. Tenta buscar metadados leves via rota do servidor se disponível
  try {
    const res = await fetch(`/api/gdrive/meta/${encodeURIComponent(fileId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.size > 0) {
        KNOWN_DRIVE_FILES[fileId] = { size: data.size, ext: data.ext || 'mp4' };
        return KNOWN_DRIVE_FILES[fileId];
      }
    }
  } catch (_) {}

  // 2. Fallback: busca binária ultrarrápida via HEAD com Range no próprio Google Drive
  const gdriveUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId
  )}&export=download&confirm=t`;
  let low = 10 * 1024 * 1024; // 10 MB
  let high = 12 * 1024 * 1024 * 1024; // 12 GB

  try {
    for (let i = 0; i < 24; i++) {
      const mid = Math.floor((low + high) / 2);
      const r = await fetch(gdriveUrl, {
        method: 'HEAD',
        headers: { Range: `bytes=${mid}-${mid}` },
        mode: 'cors',
        credentials: 'omit'
      });
      if (r.status === 206) {
        low = mid + 1;
      } else {
        high = mid;
      }
      if (high - low <= 65536) break;
    }
  } catch (_) {}

  const discovered = { size: high, ext: 'mp4' };
  KNOWN_DRIVE_FILES[fileId] = discovered;
  return discovered;
}

async function handleDriveStreamRequest(request, fileId) {
  const meta = await resolveFileMeta(fileId);
  const totalSize = meta.size;
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB por chunk

  let start = 0;
  let requestedEnd = null;

  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      start = parseInt(match[1], 10);
      if (match[2]) {
        requestedEnd = parseInt(match[2], 10);
      }
    }
  }

  if (start >= totalSize) {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${totalSize}`
      }
    });
  }

  const end =
    requestedEnd !== null
      ? Math.min(requestedEnd, start + CHUNK_SIZE - 1, totalSize - 1)
      : Math.min(start + CHUNK_SIZE - 1, totalSize - 1);

  const gdriveUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId
  )}&export=download&confirm=t`;

  const upstream = await fetch(gdriveUrl, {
    method: 'GET',
    headers: {
      Range: `bytes=${start}-${end}`
    },
    mode: 'cors',
    credentials: 'omit'
  });

  if (!upstream.ok && upstream.status !== 206) {
    // Fallback para o servidor caso o navegador bloqueie algum recurso específico
    return fetch(request);
  }

  const buffer = await upstream.arrayBuffer();
  const actualEnd = start + buffer.byteLength - 1;

  return new Response(buffer, {
    status: 206,
    headers: {
      'Content-Type': meta.ext === 'webm' ? 'video/webm' : 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(buffer.byteLength),
      'Content-Range': `bytes ${start}-${actualEnd}/${totalSize}`,
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/api\/gdrive\/stream\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    event.respondWith(handleDriveStreamRequest(event.request, match[1]));
  }
});
