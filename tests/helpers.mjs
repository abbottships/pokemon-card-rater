// Test helpers: load OpenCV in Node, read card images, and build synthetic
// "card held up to a camera" scenes with known corner positions.
import { readdirSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import sharp from 'sharp';
import cvModule from '@techstark/opencv-js';
import { CARD_RATIO, orderCorners } from '../src/detect.js';

export const FIXTURES = new URL('./fixtures/cards/', import.meta.url).pathname;
export const OUTPUT = new URL('./output/', import.meta.url).pathname;

let cvPromise;
export function loadCv() {
  cvPromise ??= new Promise((resolve) => {
    const done = () => {
      // The module is a thenable that resolves to itself; resolving with it would loop.
      delete cvModule.then;
      resolve(cvModule);
    };
    if (cvModule.Mat) done();
    else cvModule.onRuntimeInitialized = done;
  });
  return cvPromise;
}

/** Card images in tests/fixtures/cards, or [] if none have been added yet. */
export function fixtureCards() {
  return readdirSync(FIXTURES)
    .filter((f) => ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(f).toLowerCase()))
    .map((f) => join(FIXTURES, f));
}

/** Read an image file into an RGBA Mat. Transparent corners are flattened onto mid grey. */
export async function readImage(cv, path) {
  const { data, info } = await sharp(path)
    .flatten({ background: '#808080' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mat = new cv.Mat(info.height, info.width, cv.CV_8UC4);
  mat.data.set(data);
  return mat;
}

export async function writeImage(cv, mat, name) {
  mkdirSync(OUTPUT, { recursive: true });
  const rgba = new cv.Mat();
  if (mat.channels() === 1) cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  else mat.copyTo(rgba);
  await sharp(Buffer.from(rgba.data), { raw: { width: rgba.cols, height: rgba.rows, channels: 4 } })
    .png()
    .toFile(join(OUTPUT, name));
  rgba.delete();
}

/** A stand-in card for when no fixtures exist: yellow border, art box, text panel. */
export function syntheticCard(cv) {
  const w = 630, h = 880;
  const card = new cv.Mat(h, w, cv.CV_8UC4, new cv.Scalar(245, 205, 40, 255));
  cv.rectangle(card, new cv.Point(36, 36), new cv.Point(w - 36, h - 36), new cv.Scalar(232, 228, 215, 255), -1);
  cv.rectangle(card, new cv.Point(60, 110), new cv.Point(w - 60, 450), new cv.Scalar(70, 130, 200, 255), -1);
  cv.circle(card, new cv.Point(w / 2, 280), 110, new cv.Scalar(250, 220, 60, 255), -1);
  for (let y = 520; y < 780; y += 40) {
    cv.rectangle(card, new cv.Point(70, y), new cv.Point(w - 90, y + 12), new cv.Scalar(60, 60, 60, 255), -1);
  }
  return card;
}

/** Small deterministic PRNG so failures are reproducible. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 1280x720 background.
 * plain: flat colour (a desk or a wall). noise: fine sensor-like noise.
 * clutter: random lines and blobs, the kind of thing that confuses edge detection.
 */
export function background(cv, kind, rand, w = 1280, h = 720) {
  const base = [60 + rand() * 120, 60 + rand() * 120, 60 + rand() * 120];
  const bg = new cv.Mat(h, w, cv.CV_8UC4, new cv.Scalar(...base, 255));
  if (kind === 'noise' || kind === 'clutter') {
    const noise = new cv.Mat(h, w, cv.CV_8UC4);
    cv.randn(noise, new cv.Mat(1, 4, cv.CV_64F, new cv.Scalar(0)), new cv.Mat(1, 4, cv.CV_64F, new cv.Scalar(12)));
    const signed = new cv.Mat();
    noise.convertTo(signed, cv.CV_16SC4);
    bg.convertTo(bg, cv.CV_16SC4);
    cv.add(bg, signed, bg);
    bg.convertTo(bg, cv.CV_8UC4);
    noise.delete(); signed.delete();
  }
  if (kind === 'clutter') {
    for (let i = 0; i < 40; i++) {
      const p1 = new cv.Point(rand() * w, rand() * h);
      const p2 = new cv.Point(p1.x + (rand() - 0.5) * 300, p1.y + (rand() - 0.5) * 300);
      const c = new cv.Scalar(rand() * 255, rand() * 255, rand() * 255, 255);
      if (i % 3 === 0) cv.circle(bg, p1, 5 + rand() * 30, c, -1);
      else cv.line(bg, p1, p2, c, 1 + Math.round(rand() * 3));
    }
  }
  return bg;
}

/**
 * Random card pose inside a w x h frame: scale, rotation, a little perspective.
 * @param {'upright'|'tilted'|'sideways'} kind
 * @returns {number[][]} ground-truth corners (card top-left, top-right, bottom-right, bottom-left)
 */
export function randomPose(rand, kind, w = 1280, h = 720) {
  const cardH = h * (0.55 + rand() * 0.3);
  const cardW = cardH / CARD_RATIO;
  const angleDeg = {
    upright: (rand() - 0.5) * 10,
    tilted: (rand() < 0.5 ? -1 : 1) * (15 + rand() * 25),
    sideways: 90 + (rand() - 0.5) * 20,
  }[kind];
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);

  // Bounding box of the rotated card, so the centre keeps it fully in frame.
  const bw = Math.abs(cardW * cos) + Math.abs(cardH * sin);
  const bh = Math.abs(cardW * sin) + Math.abs(cardH * cos);
  const scale = Math.min(1, (0.95 * w) / bw, (0.95 * h) / bh);
  const cx = bw * scale / 2 + rand() * (w - bw * scale);
  const cy = bh * scale / 2 + rand() * (h - bh * scale);

  const jitter = () => (rand() - 0.5) * 0.06 * cardW * scale;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx * cardW * scale) / 2;
    const y = (sy * cardH * scale) / 2;
    return [cx + x * cos - y * sin + jitter(), cy + x * sin + y * cos + jitter()];
  });
}

/** Draw the card onto the background (in place) at the given corners. */
export function placeCard(cv, bg, card, corners) {
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, card.cols, 0, card.cols, card.rows, 0, card.rows]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
  const m = cv.getPerspectiveTransform(from, to);
  cv.warpPerspective(card, bg, m, new cv.Size(bg.cols, bg.rows), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT);
  from.delete(); to.delete(); m.delete();
}

/** Slight blur, like a real camera. */
export function soften(cv, mat) {
  cv.GaussianBlur(mat, mat, new cv.Size(3, 3), 0);
}

/**
 * Worst corner error between detected and true corners, as a fraction of the card diagonal.
 * The detector can't know which way up the card is, so all four rotations of the order are tried.
 */
export function cornerError(detected, truth) {
  const t = orderCorners(truth);
  const d = orderCorners(detected);
  const diag = Math.hypot(t[0][0] - t[2][0], t[0][1] - t[2][1]);
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    const worst = Math.max(...t.map((p, i) => {
      const q = d[(i + shift) % 4];
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    }));
    best = Math.min(best, worst);
  }
  return best / diag;
}

/**
 * How closely the crop matches the original card image (normalised correlation, 1 = identical).
 * Checks both the right way up and upside down.
 */
export function cropSimilarity(cv, crop, card) {
  const a = new cv.Mat(), b = new cv.Mat(), resized = new cv.Mat(), flipped = new cv.Mat(), result = new cv.Mat();
  try {
    cv.cvtColor(crop, a, cv.COLOR_RGBA2GRAY);
    cv.resize(card, resized, new cv.Size(crop.cols, crop.rows), 0, 0, cv.INTER_AREA);
    cv.cvtColor(resized, b, cv.COLOR_RGBA2GRAY);
    let best = -1;
    for (const img of [b, flipped]) {
      if (img === flipped) cv.flip(b, flipped, -1);
      cv.matchTemplate(a, img, result, cv.TM_CCOEFF_NORMED);
      best = Math.max(best, result.data32F[0]);
    }
    return best;
  } finally {
    a.delete(); b.delete(); resized.delete(); flipped.delete(); result.delete();
  }
}
