// Real-world tests: photos of cards with hand-marked corners in tests/fixtures/photos/labels.json.
// To add one: drop the photo in tests/fixtures/photos and add its corners to labels.json
// (any image viewer that shows pixel coordinates will do).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { detectCard, warpToCrop } from '../src/detect.js';
import { loadCv, readImage, writeImage, cornerError } from './helpers.mjs';

// Hand-marked corners are only accurate to a few pixels, so allow a bit more than the synthetic tests.
const MAX_CORNER_ERROR = 0.05;

const dir = new URL('./fixtures/photos/', import.meta.url).pathname;
const labels = JSON.parse(readFileSync(dir + 'labels.json', 'utf8'));

let cv;
before(async () => { cv = await loadCv(); });

describe('real photos', () => {
  for (const [file, { corners: truth, notes }] of Object.entries(labels)) {
    if (file.startsWith('_')) continue;
    const path = dir + file;

    test(file, { skip: !existsSync(path) && 'photo not present' }, async (t) => {
      const img = await readImage(cv, path);
      try {
        const found = detectCard(cv, img);
        assert.ok(found, `no card found (${notes})`);

        // Save the crop so a person can eyeball it.
        const { crop } = warpToCrop(cv, img, found.corners);
        await writeImage(cv, crop, `photo-crop-${file.replace(/\.\w+$/, '')}.png`);
        crop.delete();

        const err = cornerError(found.corners, truth);
        t.diagnostic(`corner error ${(err * 100).toFixed(1)}% via ${found.method}`);
        assert.ok(err <= MAX_CORNER_ERROR, `corner error ${(err * 100).toFixed(1)}% (${found.method})`);
      } finally {
        img.delete();
      }
    });
  }
});
