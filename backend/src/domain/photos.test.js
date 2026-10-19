import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compressPhoto, watermarkLines } from './photos.js';

// A plain mid-grey test "photo".
const grey = () => sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();

test('watermark lines: stage tag, lat/long and time', () => {
  const lines = watermarkLines({ stage: 'work_started', lat: 30.3165, lon: 78.0322, at: '2026-10-19T06:30:00Z' });
  assert.equal(lines[0], 'WORK STARTED');
  assert.equal(lines[1], 'Lat 30.316500  Long 78.032200');
  assert.match(lines[2], /2026/);
  assert.deepEqual(watermarkLines({ stage: 'work_finished' }), ['WORK FINISHED']);
  assert.deepEqual(watermarkLines({ stage: 'bogus' }), []);
  assert.deepEqual(watermarkLines({}), []);
});

test('the watermark is light: the photo stays almost unchanged', async () => {
  const input = await grey();
  const plain = await compressPhoto(input);
  const marked = await compressPhoto(input, { stage: 'work_finished', lat: 30.3165, lon: 78.0322, at: new Date().toISOString() });
  assert.equal(marked.contentType, 'image/webp');
  assert.equal(marked.width, 1200);
  const a = await sharp(plain.buffer).raw().toBuffer();
  const b = await sharp(marked.buffer).raw().toBuffer();
  let changed = 0, maxDiff = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 8) changed++;
    maxDiff = Math.max(maxDiff, d);
  }
  assert.ok(changed > 0, 'something was stamped');
  assert.ok(changed / a.length < 0.05, `stamp covers ${(100 * changed / a.length).toFixed(1)}% of the photo`);
  assert.ok(maxDiff < 110, `strongest change ${maxDiff} of 255: the text is translucent, not solid`);
});
