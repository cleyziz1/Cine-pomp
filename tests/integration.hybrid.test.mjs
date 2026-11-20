import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import worker from '../src/worker.js';
import { isAllowedCorsOrigin, buildCorsHeaders } from '../src/shared/media-utils.mjs';

const baseCatalog = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/drive_catalog.json'), 'utf8'));
const baseRegistry = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/media_cache/registry.json'), 'utf8'));

function makeEnv(extra = {}) {
  return {
    ENVIRONMENT: 'staging',
    ADMIN_PASSWORD: 'admin-pompeia-2026',
    ALLOWED_ORIGINS: 'https://cine.meudominio.com',
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/drive_catalog.json') {
          return new Response(JSON.stringify(baseCatalog), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (u.pathname === '/media_cache/registry.json') {
          return new Response(JSON.stringify(baseRegistry), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      }
    },
    ...extra
  };
}

test('Vercel & Cloudflare hybrid configs are valid and prevent media_cache duplication', () => {
  const vercelCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8'));
  assert.equal(vercelCfg.outputDirectory, 'public');
  assert.ok(vercelCfg.rewrites.some((r) => r.source === '/api/:path*' && r.destination.includes('.workers.dev/api/:path*')));
  assert.ok(
    vercelCfg.rewrites.some((r) => r.source === '/media_cache/:path*' && r.destination.includes('.workers.dev/media_cache/:path*'))
  );

  const vercelIgnore = fs.readFileSync(path.join(process.cwd(), '.vercelignore'), 'utf8');
  assert.ok(vercelIgnore.includes('public/media_cache/'), '.vercelignore must exclude public/media_cache/');

  const wranglerCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'wrangler.jsonc'), 'utf8'));
  assert.equal(wranglerCfg.name, 'cine-pomp');
  assert.equal(wranglerCfg.env.staging.name, 'cine-pomp-staging');
  assert.equal(wranglerCfg.env.staging.vars.ENVIRONMENT, 'staging');

  // Executa o script de build da Vercel e valida env-config.js sem segredos
  execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/prepare-vercel.js')], {
    env: { ...process.env, VERCEL_ENV: 'preview' }
  });
  const envJs = fs.readFileSync(path.join(process.cwd(), 'public/env-config.js'), 'utf8');
  assert.ok(envJs.includes('hybrid-vercel-cloudflare'));
  assert.ok(envJs.includes('cine-pomp-staging.cz-santosf.workers.dev'));
  assert.ok(!envJs.includes('ADMIN_PASSWORD') && !envJs.includes('TMDB_API_KEY'));
});

test('Worker CORS allowlist allows Vercel/Cloudflare/localhost/custom origins and blocks unknown origins', async () => {
  assert.equal(isAllowedCorsOrigin('https://cine-pomp.vercel.app'), true);
  assert.equal(isAllowedCorsOrigin('https://cine-pomp.cz-santosf.workers.dev'), true);
  assert.equal(isAllowedCorsOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedCorsOrigin('https://cine.meudominio.com', 'https://cine.meudominio.com'), true);
  assert.equal(isAllowedCorsOrigin('https://evil.example.com', 'https://cine.meudominio.com'), false);
  assert.deepEqual(buildCorsHeaders('https://evil.example.com'), {});

  const env = makeEnv();
  const rOpt = await worker.fetch(
    new Request('https://cine-pomp.workers.dev/api/drive/catalog', {
      method: 'OPTIONS',
      headers: { Origin: 'https://cine-pomp-preview.vercel.app' }
    }),
    env,
    { waitUntil() {} }
  );
  assert.equal(rOpt.status, 204);
  assert.equal(rOpt.headers.get('access-control-allow-origin'), 'https://cine-pomp-preview.vercel.app');
  assert.ok(rOpt.headers.get('x-request-id'));
});

test('Worker /api/health and /api/videos/:id/download (HEAD 200 & GET 302) work safely', async () => {
  const env = makeEnv();

  const rHealth = await worker.fetch(
    new Request('https://cine-pomp.workers.dev/api/health', {
      headers: { Origin: 'https://cine-pomp.vercel.app' }
    }),
    env,
    { waitUntil() {} }
  );
  assert.equal(rHealth.status, 200);
  assert.equal(rHealth.headers.get('access-control-allow-origin'), 'https://cine-pomp.vercel.app');
  const health = await rHealth.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.environment, 'staging');

  const fileId = '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN';
  const rHead = await worker.fetch(
    new Request(`https://cine-pomp.workers.dev/api/videos/${fileId}/download`, { method: 'HEAD' }),
    env,
    { waitUntil() {} }
  );
  assert.equal(rHead.status, 200);
  assert.ok((rHead.headers.get('content-disposition') || '').includes('attachment; filename='));
  assert.ok(Number(rHead.headers.get('content-length')) > 1000000000);

  const rGet = await worker.fetch(
    new Request(`https://cine-pomp.workers.dev/api/videos/${fileId}/download`, { method: 'GET' }),
    env,
    { waitUntil() {} }
  );
  assert.equal(rGet.status, 302);
  assert.ok((rGet.headers.get('location') || '').includes(`drive.usercontent.google.com/download?id=${fileId}`));

  const rBad = await worker.fetch(
    new Request('https://cine-pomp.workers.dev/api/videos/shortid/download', { method: 'GET' }),
    env,
    { waitUntil() {} }
  );
  assert.equal(rBad.status, 400);
});
