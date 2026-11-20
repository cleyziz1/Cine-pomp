#!/usr/bin/env node
'use strict';

/**
 * Gera trilhas de áudio AAC-LC Estéreo completas (100% da duração do filme)
 * em formato HLS áudio-only (segmentos de 30s, << 25 MiB por arquivo para Cloudflare Workers Assets)
 * e atualiza public/media_cache/registry.json + prepared_media/registry.json com metadados reais via ffprobe.
 *
 * Uso:
 *   node scripts/generate-full-audio-cache.js <fileId1> [fileId2 ...]
 *   node scripts/generate-full-audio-cache.js --audit-only
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_CACHE_DIR = path.join(ROOT, 'public', 'media_cache');
const PUBLIC_REG_PATH = path.join(PUBLIC_CACHE_DIR, 'registry.json');
const PREPARED_REG_PATH = path.join(ROOT, 'prepared_media', 'registry.json');

function loadRegistry() {
  return JSON.parse(fs.readFileSync(PUBLIC_REG_PATH, 'utf8'));
}

function saveRegistry(reg) {
  const json = JSON.stringify(reg, null, 2);
  fs.writeFileSync(PUBLIC_REG_PATH, json, 'utf8');
  if (fs.existsSync(path.dirname(PREPARED_REG_PATH))) {
    fs.writeFileSync(PREPARED_REG_PATH, json, 'utf8');
  }
}

function probeFile(targetPath) {
  const out = execFileSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size,bit_rate:stream=index,codec_type,codec_name,channels,sample_rate,duration,start_time:stream_tags=language,title',
      '-of',
      'json',
      targetPath
    ],
    { encoding: 'utf8', timeout: 60000 }
  );
  return JSON.parse(out);
}

function selectPreferredAudioStream(streams) {
  const audioStreams = (streams || []).filter((s) => s.codec_type === 'audio');
  if (audioStreams.length === 0) return { audioIndex: 0, stream: null };

  // Prioriza faixa em Português (por / pt / pt-BR)
  const ptIdx = audioStreams.findIndex((s) => {
    const lang = String((s.tags && s.tags.language) || '').toLowerCase();
    const title = String((s.tags && s.tags.title) || '').toLowerCase();
    return (
      lang === 'por' ||
      lang === 'pt' ||
      lang === 'pt-br' ||
      lang === 'pob' ||
      title.includes('portug') ||
      title.includes('pt-br') ||
      title.includes('dublado')
    );
  });

  const chosenPos = ptIdx >= 0 ? ptIdx : 0;
  return { audioIndex: chosenPos, stream: audioStreams[chosenPos] };
}

function auditExistingCache(reg) {
  let updated = 0;
  for (const [fileId, entry] of Object.entries(reg.files || {})) {
    const dir = path.join(PUBLIC_CACHE_DIR, fileId);
    const hlsPlaylist = path.join(dir, 'audio_0', 'index.m3u8');
    const m4aPath = path.join(dir, 'audio_0.m4a');
    const movieDur = Number(entry.durationSec || 0);

    if (fs.existsSync(hlsPlaylist)) {
      const m3u8 = fs.readFileSync(hlsPlaylist, 'utf8');
      let hlsDur = 0;
      for (const line of m3u8.split(/\r?\n/)) {
        const m = line.match(/^#EXTINF:([0-9.]+)/);
        if (m) hlsDur += parseFloat(m[1]);
      }
      entry.hasSidecarAudio0 = true;
      entry.sidecarAudioHlsUrl = `/media_cache/${fileId}/audio_0/index.m3u8`;
      entry.sidecarAudioDurationSec = Number(hlsDur.toFixed(2));
      entry.sidecarAudioComplete = movieDur > 0 ? hlsDur >= movieDur * 0.95 : hlsDur > 300;
      updated++;
    } else if (fs.existsSync(m4aPath)) {
      try {
        const probe = probeFile(m4aPath);
        const aStream = (probe.streams || []).find((s) => s.codec_type === 'audio');
        const aDur = Number((aStream && aStream.duration) || (probe.format && probe.format.duration) || 0);
        entry.sidecarAudioDurationSec = Number(aDur.toFixed(2));
        entry.sidecarAudioComplete = movieDur > 0 ? aDur >= movieDur * 0.95 : false;
        delete entry.sidecarAudioHlsUrl;
        updated++;
      } catch (_) {}
    }

    const compatPath = path.join(dir, 'compat.mp4');
    if (fs.existsSync(compatPath)) {
      try {
        const probe = probeFile(compatPath);
        const cDur = Number((probe.format && probe.format.duration) || 0);
        entry.compatDurationSec = Number(cDur.toFixed(2));
        entry.compatComplete = movieDur > 0 ? cDur >= movieDur * 0.95 : false;
        updated++;
      } catch (_) {}
    }
  }
  saveRegistry(reg);
  console.log(`[AUDIT] Atualizados ${updated} registros com duração real de áudio/compat.`);
}

async function generateFullAudioHls(fileId, reg) {
  const entry = reg.files && reg.files[fileId];
  if (!entry) {
    throw new Error(`fileId ${fileId} não encontrado em registry.json`);
  }

  const driveUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId
  )}&export=download&confirm=t`;

  console.log(`\n[START] ${fileId} — ${entry.fileName}`);
  console.log(`[PROBE] Inspecionando faixas originais no Google Drive...`);
  const sourceProbe = probeFile(driveUrl);
  const { audioIndex, stream } = selectPreferredAudioStream(sourceProbe.streams);
  const movieDur = Number((sourceProbe.format && sourceProbe.format.duration) || entry.durationSec || 0);
  console.log(
    `[PROBE] Duração: ${movieDur.toFixed(1)}s | Faixa escolhida: 0:a:${audioIndex} (${
      stream ? `${stream.codec_name} ${stream.channels}ch ${JSON.stringify(stream.tags || {})}` : 'desconhecida'
    })`
  );

  const outDir = path.join(PUBLIC_CACHE_DIR, fileId, 'audio_0');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    fs.unlinkSync(path.join(outDir, f));
  }

  const playlistPath = path.join(outDir, 'index.m3u8');
  const segmentPattern = path.join(outDir, 'seg_%03d.ts');

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_at_eof',
    '1',
    '-reconnect_delay_max',
    '5',
    '-user_agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-i',
    driveUrl,
    '-vn',
    '-sn',
    '-dn',
    '-map',
    `0:a:${audioIndex}`,
    '-c:a',
    'aac',
    '-profile:a',
    'aac_low',
    '-b:a',
    '48k',
    '-ac',
    '2',
    '-ar',
    '44100',
    '-af',
    'aresample=async=1:first_pts=0',
    '-f',
    'hls',
    '-hls_time',
    '30',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    segmentPattern,
    playlistPath
  ];

  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg saiu com código ${code}: ${stderrBuf.slice(-500)}`));
    });
  });

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  const m3u8 = fs.readFileSync(playlistPath, 'utf8');
  let totalDur = 0;
  let segCount = 0;
  let maxSegBytes = 0;
  let totalBytes = 0;
  for (const line of m3u8.split(/\r?\n/)) {
    const m = line.match(/^#EXTINF:([0-9.]+)/);
    if (m) totalDur += parseFloat(m[1]);
    if (line.endsWith('.ts')) {
      segCount++;
      const sz = fs.statSync(path.join(outDir, line.trim())).size;
      totalBytes += sz;
      if (sz > maxSegBytes) maxSegBytes = sz;
    }
  }

  const coveragePct = movieDur > 0 ? (totalDur / movieDur) * 100 : 0;
  console.log(
    `[DONE] ${fileId} em ${elapsedSec}s | segs=${segCount} | total=${(totalBytes / 1024 / 1024).toFixed(
      2
    )}MB | maxSeg=${(maxSegBytes / 1024).toFixed(1)}KB | dur=${totalDur.toFixed(1)}s / ${movieDur.toFixed(
      1
    )}s (${coveragePct.toFixed(1)}%)`
  );

  if (movieDur > 0 && totalDur < movieDur * 0.95) {
    throw new Error(`Áudio gerado incompleto (${coveragePct.toFixed(1)}% da duração do filme).`);
  }

  // Remove o audio_0.m4a truncado antigo se existir
  const oldM4a = path.join(PUBLIC_CACHE_DIR, fileId, 'audio_0.m4a');
  if (fs.existsSync(oldM4a)) {
    fs.unlinkSync(oldM4a);
  }

  entry.hasSidecarAudio0 = true;
  entry.sidecarAudioHlsUrl = `/media_cache/${fileId}/audio_0/index.m3u8`;
  entry.sidecarAudioUrl = `/media_cache/${fileId}/audio_0/index.m3u8`;
  entry.sidecarAudioDurationSec = Number(totalDur.toFixed(2));
  entry.sidecarAudioComplete = true;
  entry.updatedAt = new Date().toISOString();
  saveRegistry(reg);
}

(async () => {
  const args = process.argv.slice(2);
  const reg = loadRegistry();
  if (args.length === 0 || args.includes('--audit-only')) {
    auditExistingCache(reg);
    return;
  }

  for (const fileId of args) {
    if (fileId.startsWith('--')) continue;
    await generateFullAudioHls(fileId, reg);
  }
  auditExistingCache(reg);
})().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
