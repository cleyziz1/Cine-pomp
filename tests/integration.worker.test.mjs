import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../src/worker.js';

const baseCatalog = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/drive_catalog.json'), 'utf8'));
const baseRegistry = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/media_cache/registry.json'), 'utf8'));

function makeEnv() {
  return {
    ADMIN_PASSWORD: 'admin-pompeia-2026',
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/drive_catalog.json') {
          return new Response(JSON.stringify(baseCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (u.pathname === '/media_cache/registry.json') {
          return new Response(JSON.stringify(baseRegistry), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response('Not Found', { status: 404 });
      }
    }
  };
}

function buildEmbedHtml(entries) {
  return entries.map((e) => `<div id="entry-${e.id}"><div class="flip-entry-title">${e.name}</div></div>`).join('\n');
}

test('Worker attaches security headers, X-Request-Id, enforces RBAC 403 and login rate limit 429', async () => {
  const env = makeEnv();

  // RBAC: sem token -> 403
  const r403 = await worker.fetch(new Request('https://cine-pomp.workers.dev/api/admin/movies-health'), env, {
    waitUntil() {}
  });
  assert.equal(r403.status, 403);
  assert.equal(r403.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r403.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(r403.headers.get('x-request-id'));

  // Rate limiting em /api/auth/login (8 falhas -> 9a retorna 429)
  const testIp = '203.0.113.77';
  for (let i = 0; i < 8; i++) {
    const res = await worker.fetch(
      new Request('https://cine-pomp.workers.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': testIp },
        body: JSON.stringify({ password: 'wrong-password' })
      }),
      env,
      { waitUntil() {} }
    );
    assert.equal(res.status, 401);
  }
  const r429 = await worker.fetch(
    new Request('https://cine-pomp.workers.dev/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': testIp },
      body: JSON.stringify({ password: 'wrong-password' })
    }),
    env,
    { waitUntil() {} }
  );
  assert.equal(r429.status, 429);
  assert.ok(Number(r429.headers.get('retry-after')) > 0);
});

test('Worker diagnostics confirms full HLS AAC-LC for Civil War, Harry Potter 3, Amazing Spider-Man, and P.D.', async () => {
  const env = makeEnv();
  const expectedFullHlsIds = [
    '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN',
    '17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq',
    '1AayQ_w6esYnD4tUK2Fl32aORrXNjt06j',
    '1TkM-Ch8w6lBDyc3DdJL1rZmdLyBwBd3e'
  ];

  for (const id of expectedFullHlsIds) {
    const res = await worker.fetch(
      new Request(`https://cine-pomp.workers.dev/api/videos/${id}/diagnostics`),
      env,
      { waitUntil() {} }
    );
    assert.equal(res.status, 200);
    const diag = await res.json();
    assert.equal(diag.sidecarAudioComplete, true, `${id} should have complete sidecar`);
    assert.equal(diag.sidecarAudioHlsUrl, `/media_cache/${id}/audio_0/index.m3u8`);
    assert.ok(diag.sidecarAudioDurationSec > 5000, `${id} duration should be > 5000s`);
  }
});

test('Worker Drive sync handles ETag 304, transient 503 retry, add, dedupe, rename, delete, and audit logs', async () => {
  const env = makeEnv();
  const origFetch = globalThis.fetch;
  const baseEntries = (baseCatalog.movies || []).map((m) => ({
    id: m.driveFileId,
    name: m.fileName || `${m.title}.mp4`
  }));
  let mockEntries = [...baseEntries];
  let failOnce503 = false;

  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.includes('embeddedfolderview')) {
      if (failOnce503) {
        failOnce503 = false;
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(buildEmbedHtml(mockEntries), { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (s.includes('itunes.apple.com') || s.includes('themoviedb.org')) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return origFetch(url, init);
  };

  try {
    // Login admin com IP limpo
    const loginRes = await worker.fetch(
      new Request('https://cine-pomp.workers.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.10' },
        body: JSON.stringify({ password: 'admin-pompeia-2026' })
      }),
      env,
      { waitUntil() {} }
    );
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();

    // Catalog + ETag + 304
    const rCat = await worker.fetch(new Request('https://cine-pomp.workers.dev/api/drive/catalog?refresh=1'), env, {
      waitUntil() {}
    });
    assert.equal(rCat.status, 200);
    assert.equal(rCat.headers.get('cache-control'), 'no-cache, must-revalidate');
    const etag = rCat.headers.get('etag');
    assert.ok(etag);

    const r304 = await worker.fetch(
      new Request('https://cine-pomp.workers.dev/api/drive/catalog', { headers: { 'If-None-Match': etag } }),
      env,
      { waitUntil() {} }
    );
    assert.equal(r304.status, 304);

    // Add + transient 503 retry
    failOnce503 = true;
    mockEntries = [{ id: 'TEST_SYNC_FILE_0000001', name: 'Duna.2021.1080p.mp4' }, ...baseEntries];
    const rAdd = await worker.fetch(
      new Request('https://cine-pomp.workers.dev/api/drive/sync-folder', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
      env,
      { waitUntil() {} }
    );
    const dAdd = await rAdd.json();
    assert.equal(dAdd.addedCount, 1);

    // Duplicate protection
    const rDup = await worker.fetch(
      new Request('https://cine-pomp.workers.dev/api/drive/sync-folder', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
      env,
      { waitUntil() {} }
    );
    assert.equal((await rDup.json()).addedCount, 0);

    // Rename
    mockEntries = [{ id: 'TEST_SYNC_FILE_0000001', name: 'Duna.Parte.Um.2021.1080p.mp4' }, ...baseEntries];
    const rRen = await worker.fetch(
      new Request('https://cine-pomp.workers.dev/api/drive/sync-folder', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
      env,
      { waitUntil() {} }
    );
    assert.equal((await rRen.json()).renamedCount, 1);

    // Delete
    mockEntries = [...baseEntries];
    const rDel = await worker.fetch(
      new Request('https://cine-pomp.workers.dev/api/drive/sync-folder', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
      env,
      { waitUntil() {} }
    );
    assert.equal((await rDel.json()).removedCount, 1);

    // Audit logs in sync-status
    const rSt = await worker.fetch(new Request('https://cine-pomp.workers.dev/api/drive/sync-status'), env, {
      waitUntil() {}
    });
    const dSt = await rSt.json();
    assert.ok(Array.isArray(dSt.recentEvents) && dSt.recentEvents.length >= 4);
  } finally {
    globalThis.fetch = origFetch;
  }
});
