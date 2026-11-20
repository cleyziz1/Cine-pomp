import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECURITY_HEADERS,
  generateRequestId,
  constantTimeEqual,
  isValidDriveFileId,
  extractDriveFileId,
  extractDriveFolderId,
  getStreamMimeType,
  parseHttpByteRange,
  patchEbmlHeaderForUnsupportedAudio,
  parseMovieFilename,
  computeTitleSimilarity
} from '../src/shared/media-utils.mjs';

test('parseHttpByteRange handles standard, open-ended, suffix, missing, and invalid 416 ranges', () => {
  const total = 100 * 1024 * 1024;
  const cap = 8 * 1024 * 1024;

  const r1 = parseHttpByteRange('bytes=0-65535', total, cap);
  assert.deepEqual(r1, { ok: true, start: 0, end: 65535, chunkLen: 65536, isPartial: true });

  const rOpen = parseHttpByteRange('bytes=1024-', total, cap);
  assert.equal(rOpen.ok, true);
  assert.equal(rOpen.start, 1024);
  assert.equal(rOpen.end, 1024 + cap - 1);
  assert.equal(rOpen.chunkLen, cap);

  const rSuffix = parseHttpByteRange('bytes=-4096', total, cap);
  assert.equal(rSuffix.ok, true);
  assert.equal(rSuffix.start, total - 4096);
  assert.equal(rSuffix.end, total - 1);
  assert.equal(rSuffix.chunkLen, 4096);

  const rNoHeader = parseHttpByteRange(null, total, cap);
  assert.equal(rNoHeader.ok, true);
  assert.equal(rNoHeader.isPartial, false);

  assert.equal(parseHttpByteRange('bytes=999999999-', total, cap).status, 416);
  assert.equal(parseHttpByteRange('bytes=500-100', total, cap).status, 416);
  assert.equal(parseHttpByteRange('items=0-10', total, cap).status, 416);
});

test('patchEbmlHeaderForUnsupportedAudio masks single AC-3, multiple E-AC-3, and preserves A_AAC + byte length', () => {
  // Constrói cabeçalho sintético EBML com 2 faixas A_EAC3 + 1 faixa A_AAC
  const head = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]),
    // TrackEntry 1: A_EAC3 (TrackType 0x83 0x81 0x02)
    Buffer.from([0xae, 0x10, 0x83, 0x81, 0x02]),
    Buffer.from('A_EAC3'),
    // TrackEntry 2: A_EAC3 (TrackType 0x83 0x81 0x02)
    Buffer.from([0xae, 0x10, 0x83, 0x81, 0x02]),
    Buffer.from('A_EAC3'),
    // TrackEntry 3: A_AAC (TrackType 0x83 0x81 0x02 — DEVE permanecer 0x02!)
    Buffer.from([0xae, 0x10, 0x83, 0x81, 0x02]),
    Buffer.from('A_AAC'),
    Buffer.alloc(64, 0x00)
  ]);

  const patched = patchEbmlHeaderForUnsupportedAudio(head);
  assert.equal(patched.byteLength, head.byteLength);

  // Ambas as faixas A_EAC3 devem virar 0x20; A_AAC deve continuar 0x02
  const hex = Buffer.from(patched).toString('hex');
  const matches = hex.match(/8381../g);
  assert.deepEqual(matches, ['838120', '838120', '838102']);

  // Buffer MP4 (não-EBML) deve permanecer idêntico
  const mp4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(80, 0x00)]);
  assert.equal(patchEbmlHeaderForUnsupportedAudio(mp4), mp4);
});

test('parseMovieFilename and computeTitleSimilarity normalize movie titles cleanly', () => {
  const p1 = parseMovieFilename('Capitão.América.Guerra.Civil.2016.WEB-DL.1080p.x264.DUAL.5.1-SF.mkv');
  assert.equal(p1.year, '2016');
  assert.ok(computeTitleSimilarity(p1.title, 'Capitão América: Guerra Civil') >= 0.9);

  const p2 = parseMovieFilename('P.D.mp4');
  assert.equal(p2.title, 'Chicago P.D.: Distrito 21');
});

test('Drive ID validators, security headers, request IDs, and constantTimeEqual work correctly', () => {
  assert.equal(isValidDriveFileId('1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN'), true);
  assert.equal(isValidDriveFileId('../etc/passwd'), false);
  assert.equal(
    extractDriveFileId('https://drive.google.com/file/d/1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN/view'),
    '1XOa5GObpQn2urVO8EeTl2o7omZCTpwXN'
  );
  assert.equal(
    extractDriveFolderId('https://drive.google.com/drive/folders/185iFV7I5x107sxJDTVbSxA9F0pY3GtTr?usp=drive_link'),
    '185iFV7I5x107sxJDTVbSxA9F0pY3GtTr'
  );
  assert.equal(getStreamMimeType('video/x-matroska', 'test.mkv'), 'video/mp4');
  assert.equal(getStreamMimeType('', 'test.webm'), 'video/webm');
  assert.equal(constantTimeEqual('secret123', 'secret123'), true);
  assert.equal(constantTimeEqual('secret123', 'secret124'), false);
  assert.equal(constantTimeEqual('short', 'muchlonger'), false);
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.ok(generateRequestId().startsWith('cp_'));
});
