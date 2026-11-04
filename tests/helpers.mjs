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
export function background(cv, kind, rand, w = 1280, h = 720, colour = null) {
  const base = colour ?? [60 + rand() * 120, 60 + rand() * 120, 60 + rand() * 120];
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
 * @param {number} [size] scales the card (1 = 55-85% of the frame height)
 * @returns {number[][]} ground-truth corners (card top-left, top-right, bottom-right, bottom-left)
 */
export function randomPose(rand, kind, w = 1280, h = 720, size = 1) {
  const cardH = h * (0.55 + rand() * 0.3) * size;
  const cardW = cardH / CARD_RATIO;
  const angleDeg = {
    upright: (rand() - 0.5) * 10,
    tilted: (rand() < 0.5 ? -1 : 1) * (15 + rand() * 25),
    sideways: 90 + (rand() - 0.5) * 20,
  }[kind];
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);

  // Bounding box of the rotated card, kept inside a margin so the card (plus the
  // corner jitter below, at most 3% of its width) is always fully in frame.
  const margin = 0.04 * Math.min(w, h);
  const bw = Math.abs(cardW * cos) + Math.abs(cardH * sin);
  const bh = Math.abs(cardW * sin) + Math.abs(cardH * cos);
  const scale = Math.min(1, (w - 2 * margin) / bw, (h - 2 * margin) / bh);
  const cx = margin + bw * scale / 2 + rand() * (w - 2 * margin - bw * scale);
  const cy = margin + bh * scale / 2 + rand() * (h - 2 * margin - bh * scale);

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

/**
 * Mean RGB of the card's outer border: a thin strip just inside its left edge.
 * Used to build a background the card barely stands out from (a yellow card on a yellow wall).
 */
export function borderColour(cv, card) {
  const x = Math.round(card.cols * 0.012);
  const strip = card.roi(new cv.Rect(x, Math.round(card.rows * 0.3), Math.max(2, Math.round(card.cols * 0.012)), Math.round(card.rows * 0.4)));
  try {
    const m = cv.mean(strip);
    return [m[0], m[1], m[2]];
  } finally {
    strip.delete();
  }
}

/** Points along the card's outline: t in [0, 1) around the perimeter, starting at the top-left corner. */
function along(corners, side, t) {
  const a = corners[side], b = corners[(side + 1) % 4];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function scaleAbout(corners, k) {
  const cx = corners.reduce((s, p) => s + p[0], 0) / 4;
  const cy = corners.reduce((s, p) => s + p[1], 0) / 4;
  return corners.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

function fillPoly(cv, mat, pts, colour) {
  const poly = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat().map(Math.round));
  const polys = new cv.MatVector();
  polys.push_back(poly);
  cv.fillPoly(mat, polys, new cv.Scalar(...colour, 255));
  poly.delete(); polys.delete();
}

/** Blend `colour` over the scene inside a polygon, at the given opacity. */
function tintPoly(cv, scene, pts, colour, alpha) {
  const mask = cv.Mat.zeros(scene.rows, scene.cols, cv.CV_8U);
  const solid = new cv.Mat(scene.rows, scene.cols, scene.type(), new cv.Scalar(...colour, 255));
  const blended = new cv.Mat();
  const poly = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat().map(Math.round));
  const polys = new cv.MatVector();
  polys.push_back(poly);
  cv.fillPoly(mask, polys, new cv.Scalar(255));
  cv.addWeighted(scene, 1 - alpha, solid, alpha, 0, blended);
  blended.copyTo(scene, mask);
  mask.delete(); solid.delete(); blended.delete(); poly.delete(); polys.delete();
}

/**
 * A clear plastic sleeve over a placed card: a slightly larger, faintly whitened outline
 * plus a diagonal glare streak across the card.
 */
export function addSleeve(cv, scene, corners, rand) {
  tintPoly(cv, scene, scaleAbout(corners, 1.05), [235, 235, 240], 0.18);
  const t = 0.2 + rand() * 0.5;
  const w = 0.08 + rand() * 0.08;
  const streak = [along(corners, 0, t), along(corners, 0, t + w), along(corners, 2, 1 - t - w - 0.2), along(corners, 2, 1 - t - 0.2)];
  tintPoly(cv, scene, streak, [255, 255, 255], 0.35 + rand() * 0.2);
}

const SKIN = [[224, 172, 140], [198, 134, 98], [141, 85, 60], [236, 196, 170]];

function fingerAt(cv, scene, centre, edgeAngle, len, width, colour) {
  const angle = (edgeAngle * 180) / Math.PI + 90;
  cv.ellipse(scene, new cv.Point(centre[0], centre[1]), new cv.Size(len, width), angle, 0, 360, new cv.Scalar(...colour, 255), -1);
}

/**
 * A hand holding the card: fingers behind one long edge (drawn before the card, so they
 * show only outside it) and a thumb over the opposite edge (drawn after).
 * Call with phase 'behind' before placeCard and 'front' after.
 */
export function addHand(cv, scene, corners, rand, phase, state = {}) {
  if (phase === 'behind') {
    state.side = rand() < 0.5 ? 1 : 3;
    state.skin = SKIN[Math.floor(rand() * SKIN.length)];
    state.cardW = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]);
    const a = corners[state.side], b = corners[(state.side + 1) % 4];
    const edgeAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const p = along(corners, state.side, 0.25 + (i + rand() * 0.5) * (0.5 / n));
      fingerAt(cv, scene, p, edgeAngle, state.cardW * 0.28, state.cardW * 0.08, state.skin);
    }
    return state;
  }
  const opposite = (state.side + 2) % 4;
  const a = corners[opposite], b = corners[(opposite + 1) % 4];
  const edgeAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const p = along(corners, opposite, 0.35 + rand() * 0.3);
  fingerAt(cv, scene, p, edgeAngle, state.cardW * 0.22, state.cardW * 0.1, state.skin);
  return state;
}

/**
 * Things that are not cards, drawn onto a scene, for checking the detector says "no card".
 * face: a skin-coloured oval with hair and features (the kite the detector drew round a face).
 * square: a coaster-like square. phone: a dark rounded slab at about 2:1.
 * triangle: a strong-edged triangle.
 */
export function addDistractor(cv, scene, kind, rand) {
  const w = scene.cols, h = scene.rows;
  const cx = w * (0.35 + rand() * 0.3), cy = h * (0.4 + rand() * 0.2);
  const s = h * (0.5 + rand() * 0.25);
  const rot = (rand() - 0.5) * 30;
  const box = (bw, bh) => {
    const a = (rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const x = (sx * bw) / 2, y = (sy * bh) / 2;
      return [cx + x * cos - y * sin, cy + x * sin + y * cos];
    });
  };
  if (kind === 'face') {
    const skin = SKIN[Math.floor(rand() * SKIN.length)];
    cv.ellipse(scene, new cv.Point(cx, cy - s * 0.35), new cv.Size(s * 0.42, s * 0.3), rot, 180, 360, new cv.Scalar(200, 200, 195, 255), -1);
    cv.ellipse(scene, new cv.Point(cx, cy), new cv.Size(s * 0.33, s * 0.45), rot, 0, 360, new cv.Scalar(...skin, 255), -1);
    cv.ellipse(scene, new cv.Point(cx, cy + s * 0.28), new cv.Size(s * 0.3, s * 0.2), rot, 0, 180, new cv.Scalar(60, 40, 30, 255), -1);
    for (const dx of [-0.13, 0.13]) cv.circle(scene, new cv.Point(cx + dx * s, cy - s * 0.08), s * 0.03, new cv.Scalar(50, 50, 60, 255), -1);
    cv.ellipse(scene, new cv.Point(cx, cy + s * 0.75), new cv.Size(s * 0.6, s * 0.3), 0, 180, 360, new cv.Scalar(190, 170, 140, 255), -1);
  } else if (kind === 'square') {
    fillPoly(cv, scene, box(s * 0.6, s * 0.6), [180 + rand() * 60, 60 + rand() * 60, 60, 255].slice(0, 3));
  } else if (kind === 'phone') {
    const pts = box(s * 0.42, s * 0.88);
    fillPoly(cv, scene, pts, [25, 25, 30]);
    fillPoly(cv, scene, scaleAbout(pts, 0.9), [40, 70, 120]);
  } else if (kind === 'triangle') {
    const pts = box(s * 0.7, s * 0.8);
    fillPoly(cv, scene, [pts[0], pts[1], [(pts[2][0] + pts[3][0]) / 2, (pts[2][1] + pts[3][1]) / 2]], [230, 230, 230]);
  }
}

/**
 * Make a clean render look like a laptop webcam frame: captured at lower resolution,
 * soft focus, uneven lighting across the frame and sensor noise. In place.
 */
export function webcam(cv, mat, rand) {
  const w = mat.cols, h = mat.rows;
  const small = new cv.Mat();
  cv.resize(mat, small, new cv.Size(Math.round(w / 2), Math.round(h / 2)), 0, 0, cv.INTER_AREA);
  cv.resize(small, mat, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
  small.delete();
  const sigma = 1.5 + rand() * 1.5;
  cv.GaussianBlur(mat, mat, new cv.Size(0, 0), sigma);

  // Light falls off from one side: scale brightness along a random direction.
  const a = rand() * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
  const lo = 0.7 + rand() * 0.15, hi = 1.05 + rand() * 0.1;
  const d = mat.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = 0.5 + ((x / w - 0.5) * dx + (y / h - 0.5) * dy) * 0.7;
      const k = lo + (hi - lo) * t;
      const i = (y * w + x) * 4;
      d[i] = Math.min(255, d[i] * k); d[i + 1] = Math.min(255, d[i + 1] * k); d[i + 2] = Math.min(255, d[i + 2] * k);
    }
  }
  const noise = new cv.Mat(h, w, cv.CV_16SC4);
  cv.randn(noise, new cv.Mat(1, 4, cv.CV_64F, new cv.Scalar(0)), new cv.Mat(1, 4, cv.CV_64F, new cv.Scalar(6)));
  const wide = new cv.Mat();
  mat.convertTo(wide, cv.CV_16SC4);
  cv.add(wide, noise, wide);
  wide.convertTo(mat, cv.CV_8UC4);
  // randn fills alpha too; keep the frame opaque.
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  noise.delete(); wide.delete();
}

/**
 * Something card-shaped and bigger around where the card will go: a photo, a picture
 * frame, a phone screen. Draw before placeCard. Returns its corners.
 */
export function addFrame(cv, scene, corners, rand) {
  const k = 1.35 + rand() * 0.3;
  const around = scaleAbout(corners, k).map(([x, y]) => [
    Math.min(scene.cols - 8, Math.max(8, x)), Math.min(scene.rows - 8, Math.max(8, y)),
  ]);
  fillPoly(cv, scene, around, [40 + rand() * 180, 40 + rand() * 180, 40 + rand() * 180]);
  return around;
}
