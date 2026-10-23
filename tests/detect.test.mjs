// Detection tests: put each fixture card into synthetic scenes with known corners
// and check the detector finds it and cuts out the right thing.
//
// Add card images to tests/fixtures/cards (or run `npm run fixtures`).
// With no fixtures, a synthetic card is used so the suite still runs.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { detectCard, warpToCrop, CROP_W, CROP_H } from '../src/detect.js';
import {
  loadCv, fixtureCards, readImage, writeImage, syntheticCard,
  rng, background, randomPose, placeCard, soften, cornerError, cropSimilarity,
} from './helpers.mjs';

const MAX_CORNER_ERROR = 0.04; // 4% of the card diagonal
const MIN_SIMILARITY = 0.6;
const POSES_PER_CASE = 3;

// Scenes the detector must handle in v0. Clutter is measured, not required (see below).
const CASES = [
  { bg: 'plain', pose: 'upright' },
  { bg: 'plain', pose: 'tilted' },
  { bg: 'plain', pose: 'sideways' },
  { bg: 'noise', pose: 'upright' },
  { bg: 'noise', pose: 'tilted' },
];

let cv;
before(async () => { cv = await loadCv(); });

const files = fixtureCards();
const cards = files.length ? files : [null];
if (!files.length) console.log('No fixtures in tests/fixtures/cards; using a synthetic card. Run `npm run fixtures`.');

for (const file of cards) {
  const name = file ? basename(file) : 'synthetic card';

  describe(name, () => {
    let card;
    before(async () => { card = file ? await readImage(cv, file) : syntheticCard(cv); });

    for (const { bg, pose } of CASES) {
      test(`${pose} on ${bg} background`, async () => {
        for (let i = 0; i < POSES_PER_CASE; i++) {
          const seed = hash(`${name}|${bg}|${pose}|${i}`);
          const rand = rng(seed);
          const scene = background(cv, bg, rand);
          const truth = randomPose(rand, pose);
          placeCard(cv, scene, card, truth);
          soften(cv, scene);

          try {
            const found = detectCard(cv, scene);
            if (!found) {
              await writeImage(cv, scene, `miss-${slug(name)}-${bg}-${pose}-${i}.png`);
              assert.fail(`no card found (seed ${seed}); scene saved to tests/output`);
            }

            const err = cornerError(found.corners, truth);
            assert.ok(err <= MAX_CORNER_ERROR,
              `corner error ${(err * 100).toFixed(1)}% > ${MAX_CORNER_ERROR * 100}% (seed ${seed}, ${found.method})`);

            const { crop, sharpness } = warpToCrop(cv, scene, found.corners);
            try {
              assert.equal(crop.cols, CROP_W);
              assert.equal(crop.rows, CROP_H);
              assert.ok(sharpness > 0);
              const sim = cropSimilarity(cv, crop, card);
              if (sim < MIN_SIMILARITY) await writeImage(cv, crop, `crop-${slug(name)}-${bg}-${pose}-${i}.png`);
              assert.ok(sim >= MIN_SIMILARITY, `crop similarity ${sim.toFixed(2)} < ${MIN_SIMILARITY} (seed ${seed})`);
            } finally {
              crop.delete();
            }
          } finally {
            scene.delete();
          }
        }
      });
    }

    // Busy backgrounds are where classic CV is expected to struggle. Report the hit
    // rate rather than fail, so the number can be tracked as the detector improves.
    test('cluttered background (measured, not required)', (t) => {
      const runs = 10;
      let hits = 0;
      for (let i = 0; i < runs; i++) {
        const rand = rng(hash(`${name}|clutter|${i}`));
        const scene = background(cv, 'clutter', rand);
        const truth = randomPose(rand, i % 2 ? 'tilted' : 'upright');
        placeCard(cv, scene, card, truth);
        soften(cv, scene);
        const found = detectCard(cv, scene);
        if (found && cornerError(found.corners, truth) <= MAX_CORNER_ERROR) hits++;
        scene.delete();
      }
      t.diagnostic(`clutter hit rate: ${hits}/${runs}`);
    });
  });
}

describe('no card in frame', () => {
  for (const bg of ['plain', 'noise']) {
    test(`${bg} background returns null`, () => {
      const scene = background(cv, bg, rng(hash(bg)));
      soften(cv, scene);
      try {
        assert.equal(detectCard(cv, scene), null);
      } finally {
        scene.delete();
      }
    });
  }
});

function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}
