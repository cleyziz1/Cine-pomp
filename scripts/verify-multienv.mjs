#!/usr/bin/env node
/**
 * Bateria de Testes Multiambiente (Localhost + Cloudflare) — Não destrutiva
 * Valida: Catálogo (29/29 filmes), Autenticação RBAC, Diagnostics, Thumbnails/Sprites,
 * HTTP Range 206 / 416, HLS AAC-LC, Downloads, Health, CORS e Latência.
 */

const LOCAL_BASE = (process.env.LOCAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
const CF_BASE = (process.env.CLOUDFLARE_URL || 'https://cine-pomp.cz-santosf.workers.dev').replace(/\/+$/, '');
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin-pompeia-2026';

async function timedFetch(url, opts = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, opts);
    const ms = Number((performance.now() - t0).toFixed(1));
    return { ok: true, status: res.status, headers: res.headers, res, ms };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, ms: Number((performance.now() - t0).toFixed(1)) };
  }
}

async function auditEnvironment(name, baseUrl) {
  const report = {
    environment: name,
    baseUrl,
    testedAt: new Date().toISOString(),
    results: {},
    movieCoverage: { total: 0, diagOk: 0, thumbOk: 0, hlsFullOk: 0, errors: [] },
    latenciesMs: {}
  };

  // 1. Health & UI Assets (para localhost)
  const rHealth = await timedFetch(`${baseUrl}/api/health`);
  report.results.health = { status: rHealth.status, ms: rHealth.ms };

  // 2. Catálogo + ETag/304 + Cache-Control
  const rCat = await timedFetch(`${baseUrl}/api/drive/catalog`);
  report.latenciesMs.catalog = rCat.ms;
  let movies = [];
  if (rCat.ok && rCat.status === 200) {
    const data = await rCat.res.json();
    movies = Array.isArray(data.movies) ? data.movies : [];
    const etag = rCat.headers.get('etag');
    const r304 = etag ? await timedFetch(`${baseUrl}/api/drive/catalog`, { headers: { 'If-None-Match': etag } }) : null;
    report.results.catalog = {
      pass: movies.length >= 29,
      status: rCat.status,
      totalMovies: movies.length,
      cacheControl: rCat.headers.get('cache-control'),
      etag304Status: r304 ? r304.status : null,
      ms: rCat.ms
    };
  } else {
    report.results.catalog = { pass: false, status: rCat.status, error: rCat.error || 'HTTP error' };
  }

  // 3. Autenticação RBAC (403 sem token, 200 com login admin, /api/admin/movies-health)
  const rUnauth = await timedFetch(`${baseUrl}/api/admin/movies-health`);
  const rLogin = await timedFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASS })
  });
  let healthSummary = null;
  if (rLogin.ok && rLogin.status === 200) {
    const loginData = await rLogin.res.json();
    const rAdminHealth = await timedFetch(`${baseUrl}/api/admin/movies-health`, {
      headers: { Authorization: `Bearer ${loginData.token}` }
    });
    if (rAdminHealth.ok && rAdminHealth.status === 200) {
      healthSummary = (await rAdminHealth.res.json()).summary;
    }
  }
  report.results.auth = {
    pass: rUnauth.status === 403 && rLogin.status === 200 && Boolean(healthSummary),
    unauthStatus: rUnauth.status,
    loginStatus: rLogin.status,
    healthSummary
  };

  // 4. Cobertura real de TODOS os filmes acessíveis no catálogo (/diagnostics + /thumbnails/meta)
  report.movieCoverage.total = movies.length;
  for (const m of movies) {
    const fid = m.driveFileId;
    if (!fid) continue;
    const [rDiag, rThumb] = await Promise.all([
      timedFetch(`${baseUrl}/api/videos/${fid}/diagnostics`),
      timedFetch(`${baseUrl}/api/videos/${fid}/thumbnails/meta`)
    ]);
    if (rDiag.ok && rDiag.status === 200) {
      report.movieCoverage.diagOk++;
      const d = await rDiag.res.json();
      if (d.sidecarAudioHlsUrl && d.sidecarAudioComplete) {
        const rM3u8 = await timedFetch(`${baseUrl}${d.sidecarAudioHlsUrl}`, { method: 'HEAD' });
        if (rM3u8.ok && rM3u8.status === 200) report.movieCoverage.hlsFullOk++;
        else report.movieCoverage.errors.push({ fileId: fid, title: m.title, issue: `HLS m3u8 HTTP ${rM3u8.status}` });
      }
    } else {
      report.movieCoverage.errors.push({ fileId: fid, title: m.title, issue: `diagnostics HTTP ${rDiag.status}` });
    }
    if (rThumb.ok && rThumb.status === 200) {
      report.movieCoverage.thumbOk++;
    } else {
      report.movieCoverage.errors.push({ fileId: fid, title: m.title, issue: `thumbnails/meta HTTP ${rThumb.status}` });
    }
  }

  // 5. Streaming HTTP Range 206, Range inválido 416, HEAD 200 e Downloads
  const sampleId = '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN'; // Capitão América: Guerra Civil (E-AC-3)
  const sampleHp = '17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq'; // Harry Potter 3 (AC-3)
  const rHeadStream = await timedFetch(`${baseUrl}/api/videos/${sampleId}/stream`, { method: 'HEAD' });
  const r206 = await timedFetch(`${baseUrl}/api/videos/${sampleId}/stream`, { headers: { Range: 'bytes=0-32767' } });
  const r206Hp = await timedFetch(`${baseUrl}/api/videos/${sampleHp}/stream`, { headers: { Range: 'bytes=0-32767' } });
  const r416 = await timedFetch(`${baseUrl}/api/videos/${sampleId}/stream`, {
    headers: { Range: 'bytes=999999999999-' }
  });
  const rDlHead = await timedFetch(`${baseUrl}/api/videos/${sampleId}/download`, { method: 'HEAD' });
  const rCors = await timedFetch(`${baseUrl}/api/drive/catalog`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://cine-pomp.vercel.app' }
  });

  let cwBytes = 0;
  let hpBytes = 0;
  if (r206.ok) cwBytes = (await r206.res.arrayBuffer()).byteLength;
  if (r206Hp.ok) hpBytes = (await r206Hp.res.arrayBuffer()).byteLength;

  report.latenciesMs.stream206 = r206.ms;
  report.results.streaming = {
    pass: r206.status === 206 && cwBytes === 32768 && r206Hp.status === 206 && hpBytes === 32768 && r416.status === 416,
    headStatus: rHeadStream.status,
    civilWar206: { status: r206.status, bytes: cwBytes, contentRange: r206.headers ? r206.headers.get('content-range') : null },
    harryPotter206: { status: r206Hp.status, bytes: hpBytes },
    invalidRange416: r416.status
  };

  report.results.downloads = {
    pass: rDlHead.status === 200,
    headStatus: rDlHead.status,
    contentDisposition: rDlHead.headers ? rDlHead.headers.get('content-disposition') : null
  };

  report.results.cors = {
    optionsStatus: rCors.status,
    allowOrigin: rCors.headers ? rCors.headers.get('access-control-allow-origin') : null
  };

  report.results.securityHeaders = {
    xFrameOptions: rCat.headers ? rCat.headers.get('x-frame-options') : null,
    xContentTypeOptions: rCat.headers ? rCat.headers.get('x-content-type-options') : null,
    xRequestId: rCat.headers ? Boolean(rCat.headers.get('x-request-id')) : false
  };

  return report;
}

(async () => {
  const localReport = await auditEnvironment('Localhost', LOCAL_BASE);
  const cfReport = await auditEnvironment('Cloudflare', CF_BASE);
  console.log(JSON.stringify({ localReport, cfReport }, null, 2));
})();
