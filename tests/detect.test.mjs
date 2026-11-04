// Detection tests: put each fixture card into synthetic scenes with known corners
// and check the detector finds it and cuts out the right thing.
//
// Add card images to tests/fixtures/cards (or run `npm run fixtures`).
// With no fixtures, a synthetic card is used so the suite still runs.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { detectCard, warpToCrop, CROP_W, CROP_H, CROP_PAD } from '../src/detect.js';
import {
  loadCv, fixtureCards, readImage, writeImage, syntheticCard,
  rng, background, randomPose, placeCard, soften, cornerError, cropSimilarity,
  borderColour, addHand, addSleeve, addDistractor, addFrame, webcam,
} from './helpers.mjs';

const MAX_CORNER_ERROR = 0.04; // 4% of the card diagonal
const MIN_SIMILARITY = 0.6;
const POSES_PER_CASE = 3;

// Scenes the detector must handle. Clutter and a background the colour of the card's
// border are measured, not required (see below).
// hand: fingers behind one edge and a thumb over the other, as when holding a card up.
// sleeve: a clear sleeve, slightly bigger than the card, with a glare streak.
// webcam: soft focus, half resolution, uneven light and noise, like a laptop camera.
const CASES = [
  { bg: 'plain', pose: 'upright' },
  { bg: 'plain', pose: 'tilted' },
  { bg: 'plain', pose: 'sideways' },
  { bg: 'noise', pose: 'upright' },
  { bg: 'noise', pose: 'tilted' },
  { bg: 'noise', pose: 'tilted', hand: true, webcam: true },
  { bg: 'noise', pose: 'upright', sleeve: true, webcam: true },
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

    for (const { bg, pose, hand, sleeve, webcam: cam } of CASES) {
      const extras = [
        hand && 'held in a hand', sleeve && 'in a sleeve', cam && 'on a webcam',
      ].filter(Boolean);
      const label = `${pose} on ${bg} background${extras.length ? `, ${extras.join(', ')}` : ''}`;
      test(label, async () => {
        for (let i = 0; i < POSES_PER_CASE; i++) {
          const seed = hash(`${name}|${bg}|${pose}|${extras.join('|')}|${i}`);
          const rand = rng(seed);
          const scene = background(cv, bg, rand);
          const truth = randomPose(rand, pose);
          const grip = hand ? addHand(cv, scene, truth, rand, 'behind') : null;
          placeCard(cv, scene, card, truth);
          if (sleeve) addSleeve(cv, scene, truth, rand);
          if (hand) addHand(cv, scene, truth, rand, 'front', grip);
          if (cam) webcam(cv, scene, rand); else soften(cv, scene);

          try {
            const found = detectCard(cv, scene);
            if (!found) {
              await writeImage(cv, scene, `miss-${slug(name)}-${slug(label)}-${i}.png`);
              assert.fail(`no card found (seed ${seed}); scene saved to tests/output`);
            }

            const err = cornerError(found.corners, truth);
            assert.ok(err <= MAX_CORNER_ERROR,
              `corner error ${(err * 100).toFixed(1)}% > ${MAX_CORNER_ERROR * 100}% (seed ${seed}, ${found.method})`);

            const { crop, sharpness } = warpToCrop(cv, scene, found.corners);
            try {
              assert.equal(crop.cols, CROP_W + 2 * CROP_PAD);
              assert.equal(crop.rows, CROP_H + 2 * CROP_PAD);
              assert.ok(sharpness > 0);
              // Compare the card itself, not the margin of background around it.
              const inner = crop.roi(new cv.Rect(CROP_PAD, CROP_PAD, CROP_W, CROP_H));
              const sim = cropSimilarity(cv, inner, card);
              inner.delete();
              if (sim < MIN_SIMILARITY) await writeImage(cv, crop, `crop-${slug(name)}-${slug(label)}-${i}.png`);
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

    // The card's border the same colour as the wall behind it (a yellow card on a yellow
    // wall), on a webcam. When the colours match exactly the border can't be seen at
    // all, so this is measured, not required. The crop margin is what covers the misses.
    test('background matching the border (measured, not required)', (t) => {
      const runs = 10;
      let hits = 0;
      const colour = borderColour(cv, card);
      for (let i = 0; i < runs; i++) {
        const rand = rng(hash(`${name}|matched|${i}`));
        const scene = background(cv, 'noise', rand, 1280, 720, colour.map((v) => v + (rand() - 0.5) * 30));
        const truth = randomPose(rand, i % 2 ? 'tilted' : 'upright');
        placeCard(cv, scene, card, truth);
        webcam(cv, scene, rand);
        const found = detectCard(cv, scene);
        if (found && cornerError(found.corners, truth) <= MAX_CORNER_ERROR) hits++;
        scene.delete();
      }
      t.diagnostic(`matched-border hit rate: ${hits}/${runs}`);
    });

    // A card inside something card-shaped and bigger: a photo, a picture frame, a phone
    // screen. The detector takes the outermost card shape (so it gets the card's outer
    // edge, not the frames printed inside it), which means it takes the frame here.
    // Measured, so the trade-off stays visible.
    test('inside a bigger card-shaped frame (measured, not required)', (t) => {
      const runs = 10;
      let hits = 0;
      for (let i = 0; i < runs; i++) {
        const rand = rng(hash(`${name}|framed|${i}`));
        const scene = background(cv, 'plain', rand);
        const truth = randomPose(rand, i % 2 ? 'tilted' : 'upright', 1280, 720, 0.65);
        addFrame(cv, scene, truth, rand);
        placeCard(cv, scene, card, truth);
        soften(cv, scene);
        const found = detectCard(cv, scene);
        if (found && cornerError(found.corners, truth) <= MAX_CORNER_ERROR) hits++;
        scene.delete();
      }
      t.diagnostic(`framed hit rate: ${hits}/${runs}`);
    });
  });
}

describe('no card in frame', () => {
  // Things that are not cards must not be taken for one: a face (the detector used to
  // fit a kite round one), a square, a phone, a triangle.
  for (const kind of ['face', 'square', 'phone', 'triangle']) {
    test(`a ${kind} is not a card`, async () => {
      for (let i = 0; i < 6; i++) {
        const seed = hash(`${kind}|${i}`);
        const rand = rng(seed);
        const scene = background(cv, i % 2 ? 'noise' : 'plain', rand);
        addDistractor(cv, scene, kind, rand);
        if (i % 3 === 2) webcam(cv, scene, rand); else soften(cv, scene);
        try {
          const found = detectCard(cv, scene);
          if (found) await writeImage(cv, scene, `false-${kind}-${i}.png`);
          assert.equal(found, null, `found a card in a ${kind} scene (seed ${seed}, ${found?.method}); scene saved to tests/output`);
        } finally {
          scene.delete();
        }
      }
    });
  }

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
