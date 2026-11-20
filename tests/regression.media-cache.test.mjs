import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffprobePath = require('ffprobe-static').path;

const reg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/media_cache/registry.json'), 'utf8'));

test('Full HLS AAC-LC audio caches meet duration >= 98%, codec AAC 2ch 44100Hz, and Cloudflare < 25 MiB/file', () => {
  const fullHlsIds = [
    '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN', // Capitão América: Guerra Civil (E-AC-3 -> AAC-LC)
    '17CjmCYWUpjB8XlwobdKI7fCTE8Va-wpq', // Harry Potter 3 (AC-3 -> AAC-LC)
    '1AayQ_w6esYnD4tUK2Fl32aORrXNjt06j', // O Espetacular Homem-Aranha (AC-3 -> AAC-LC)
    '1TkM-Ch8w6lBDyc3DdJL1rZmdLyBwBd3e'  // P.D.mp4 (AC-3 -> AAC-LC)
  ];

  const MAX_CF_ASSET_BYTES = 25 * 1024 * 1024;

  for (const id of fullHlsIds) {
    const entry = reg.files[id];
    assert.ok(entry, `Registry entry missing for ${id}`);
    assert.equal(entry.sidecarAudioComplete, true);

    const dir = path.join(process.cwd(), 'public/media_cache', id, 'audio_0');
    const playlistPath = path.join(dir, 'index.m3u8');
    assert.ok(fs.existsSync(playlistPath), `Missing playlist ${playlistPath}`);

    const m3u8 = fs.readFileSync(playlistPath, 'utf8');
    const segs = [];
    let totalDur = 0;
    for (const line of m3u8.split(/\r?\n/)) {
      const m = line.match(/^#EXTINF:([0-9.]+)/);
      if (m) totalDur += parseFloat(m[1]);
      if (line.trim().endsWith('.ts')) segs.push(line.trim());
    }

    assert.ok(segs.length >= 150, `${id} should have >= 150 HLS segments`);
    assert.ok(
      totalDur >= entry.durationSec * 0.98,
      `${id} HLS duration ${totalDur.toFixed(1)}s < 98% of movie ${entry.durationSec}s`
    );

    // Verifica limite Cloudflare (< 25 MiB) em todos os segmentos
    for (const seg of segs) {
      const sz = fs.statSync(path.join(dir, seg)).size;
      assert.ok(sz > 0 && sz < MAX_CF_ASSET_BYTES, `${id}/${seg} size invalid: ${sz}`);
    }

    // Valida codec real com ffprobe no primeiro e último segmento
    for (const seg of [segs[0], segs[segs.length - 1]]) {
      const out = execFileSync(
        ffprobePath,
        ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate', '-of', 'json', path.join(dir, seg)],
        { encoding: 'utf8' }
      );
      const parsed = JSON.parse(out);
      const aStream = (parsed.streams || []).find((s) => s.codec_type === 'audio');
      assert.ok(aStream, `Missing audio stream in ${id}/${seg}`);
      assert.equal(aStream.codec_name, 'aac');
      assert.equal(Number(aStream.channels), 2);
      assert.equal(Number(aStream.sample_rate), 44100);
    }
  }
});
