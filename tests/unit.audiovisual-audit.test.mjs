import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeFileVersionHash,
  validatePreviewMath,
  auditSingleMovieRecord,
  runCatalogAudiovisualAudit,
  AudiovisualAuditQueue
} from '../src/shared/audiovisual-audit.mjs';
import worker from '../src/worker.js';

const baseCatalog = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/drive_catalog.json'), 'utf8'));
const baseRegistry = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/media_cache/registry.json'), 'utf8'));

test('validatePreviewMath verifies distinct temporal quadrant tiles across 0%, 10%, 25%, 50%, 75%, 90%, 95%', () => {
  const sampleId = '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN';
  const meta = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'public/media_cache', sampleId, 'meta.json'), 'utf8')
  );
  const res = validatePreviewMath(8858.5, meta);
  assert.equal(res.valid, true);
  assert.equal(res.samplePoints.length, 7);
  // 0% deve mapear para tile 0; 50% para tile 1 ou 2; 95% para o último tile
  assert.equal(res.samplePoints[0].tileIndex, 0);
  assert.equal(res.samplePoints[6].tileIndex, res.totalTiles - 1);
  assert.ok(res.distinctTilesUsed >= 4);
});

test('runCatalogAudiovisualAudit audits all 29 movies and classifies Approved, Attention, and Fix Available', () => {
  const report = runCatalogAudiovisualAudit(baseCatalog.movies, baseRegistry.files, {});
  assert.equal(report.summary.totalRegistered, 29);
  assert.equal(report.summary.totalAudited, 29);
  assert.equal(report.summary.approved, 19);
  assert.equal(report.summary.attention, 5);
  assert.equal(report.summary.fixAvailable, 5);
  assert.equal(report.summary.criticalError, 0);
});

test('AudiovisualAuditQueue enforces idempotency, concurrency, retry backoff, and Dead-Letter Queue (DLQ)', async () => {
  const queue = new AudiovisualAuditQueue({ maxConcurrent: 2, maxRetries: 2 });
  let runs = 0;

  const r1 = queue.enqueue('fileA', 'fileA:100:mp4:3600:hls1', 'upload_detected', async () => {
    runs++;
    return { overallStatus: 'Aprovado' };
  });
  assert.equal(r1.enqueued, true);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs, 1);

  // Segunda chamada com mesmo versionHash deve ser ignorada por idempotência
  const r2 = queue.enqueue('fileA', 'fileA:100:mp4:3600:hls1', 'upload_detected', async () => {
    runs++;
    return { overallStatus: 'Aprovado' };
  });
  assert.equal(r2.enqueued, false);
  assert.equal(r2.status, 'skipped_idempotent');

  // Tarefa que falha permanentemente deve ir para a DLQ após maxRetries (2 tentativas)
  let failAttempts = 0;
  queue.enqueue('fileBad', 'fileBad:0:mkv:0:m4a0', 'upload_detected', async () => {
    failAttempts++;
    throw new Error('Corrupt stream header');
  });

  await new Promise((r) => setTimeout(r, 450));
  const snap = queue.getSnapshot();
  assert.equal(failAttempts, 2);
  assert.equal(snap.dlqCount, 1);
  assert.equal(snap.dlq[0].fileId, 'fileBad');
});

test('Worker /api/admin/audiovisual-audit and /run endpoints enforce RBAC and return live audit + queue snapshot', async () => {
  const env = {
    ADMIN_PASSWORD: 'admin-pompeia-2026',
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/drive_catalog.json') {
          return new Response(JSON.stringify(baseCatalog), { status: 200 });
        }
        if (u.pathname === '/media_cache/registry.json') {
          return new Response(JSON.stringify(baseRegistry), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }
    }
  };

  // Sem token -> 403
  const r403 = await worker.fetch(new Request('https://cine-pomp.workers.dev/api/admin/audiovisual-audit'), env, {
    waitUntil() {}
  });
  assert.equal(r403.status, 403);

  // Login admin
  const loginRes = await worker.fetch(
    new Request('https://cine-pomp.workers.dev/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.88' },
      body: JSON.stringify({ password: 'admin-pompeia-2026' })
    }),
    env,
    { waitUntil() {} }
  );
  const { token } = await loginRes.json();

  const rAudit = await worker.fetch(
    new Request('https://cine-pomp.workers.dev/api/admin/audiovisual-audit/run', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }),
    env,
    { waitUntil() {} }
  );
  assert.equal(rAudit.status, 200);
  const data = await rAudit.json();
  assert.equal(data.summary.totalRegistered, 29);
  assert.equal(data.summary.approved, 19);
  assert.ok(data.queue);
  assert.equal(data.schedule.fastCheckCron, '*/15 * * * *');
});
