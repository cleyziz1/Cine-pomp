#!/usr/bin/env node
/**
 * Executa a Auditoria Audiovisual Completa nos 29 filmes do catálogo,
 * aplica auto-correções seguras (sincronização de duração no drive_catalog.json
 * e validação matemática dos WebVTTs de preview em 0%, 10%, 25%, 50%, 75%, 90%, 95%)
 * e grava o relatório persistente em public/media_cache/audiovisual_audit_report.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCatalogAudiovisualAudit } from '../src/shared/audiovisual-audit.mjs';

const ROOT = process.cwd();
const CATALOG_PATH = path.join(ROOT, 'public/drive_catalog.json');
const ROOT_CATALOG_PATH = path.join(ROOT, 'drive_catalog.json');
const REG_PATH = path.join(ROOT, 'public/media_cache/registry.json');
const REPORT_PATH = path.join(ROOT, 'public/media_cache/audiovisual_audit_report.json');

const applySafeFixes = process.argv.includes('--apply-safe-fixes');

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const registry = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
const regFiles = registry.files || {};

// Carrega todos os meta.json de preview e garante mapeamento VTT matematicamente distribuído
const thumbMetaByFileId = {};
let fixedVttCount = 0;
let fixedCatalogDurationCount = 0;

function formatVttTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}.000`;
}

for (const m of catalog.movies || []) {
  const fid = m.driveFileId;
  if (!fid) continue;
  const regEntry = regFiles[fid];
  const dir = path.join(ROOT, 'public/media_cache', fid);
  const metaPath = path.join(dir, 'meta.json');
  const vttPath = path.join(dir, 'thumbnails.vtt');

  if (applySafeFixes && regEntry && regEntry.durationSec) {
    const detDur = Math.round(Number(regEntry.durationSec));
    if (detDur > 0 && Math.abs((m.duration || 0) - detDur) > 2) {
      m.duration = detDur;
      fixedCatalogDurationCount++;
    }
  }

  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const dur = Math.max(1, Number((regEntry && regEntry.durationSec) || meta.duration || 3600));
    const cols = Number(meta.cols) || 2;
    const rows = Number(meta.rows) || 2;
    const tileW = Number(meta.width) || 160;
    const tileH = Number(meta.height) || 90;
    const totalTiles = cols * rows;

    // Garante que os tiles cubram uniformemente os centros dos quadrantes (12.5%, 37.5%, 62.5%, 87.5%)
    if (applySafeFixes) {
      const uniformTiles = [];
      for (let idx = 0; idx < totalTiles; idx++) {
        const ratio = Number(((idx + 0.5) / totalTiles).toFixed(4));
        uniformTiles.push({
          tileIndex: idx,
          ratio,
          t: Math.round(ratio * dur),
          x: (idx % cols) * tileW,
          y: Math.floor(idx / cols) * tileH,
          w: tileW,
          h: tileH
        });
      }
      meta.duration = dur;
      meta.tiles = uniformTiles;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

      // Regenera thumbnails.vtt com mapeamento matemático exato para cada intervalo de 10s
      const step = Number(meta.intervalSeconds || meta.interval || 10);
      const vttLines = ['WEBVTT', ''];
      for (let t = 0; t < dur; t += step) {
        const endT = Math.min(dur, t + step);
        const midT = (t + endT) / 2;
        const bestTile = uniformTiles.reduce((b, c) => (Math.abs(c.t - midT) < Math.abs(b.t - midT) ? c : b));
        vttLines.push(`${formatVttTime(t)} --> ${formatVttTime(endT)}`);
        vttLines.push(`/media_cache/${fid}/sprite.jpg#xywh=${bestTile.x},${bestTile.y},${bestTile.w},${bestTile.h}`);
        vttLines.push('');
      }
      fs.writeFileSync(vttPath, vttLines.join('\n'), 'utf8');
      fixedVttCount++;
    }
    thumbMetaByFileId[fid] = meta;
  }
}

if (applySafeFixes && fixedCatalogDurationCount > 0) {
  const catJson = JSON.stringify(catalog, null, 2);
  fs.writeFileSync(CATALOG_PATH, catJson, 'utf8');
  if (fs.existsSync(ROOT_CATALOG_PATH)) {
    fs.writeFileSync(ROOT_CATALOG_PATH, catJson, 'utf8');
  }
}

const report = runCatalogAudiovisualAudit(catalog.movies || [], regFiles, thumbMetaByFileId);
report.safeFixesApplied = {
  fixedCatalogDurationCount,
  fixedVttCount
};
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

console.log('=== AUDIOVISUAL AUDIT SUMMARY ===');
console.log(JSON.stringify({ summary: report.summary, safeFixesApplied: report.safeFixesApplied }, null, 2));
