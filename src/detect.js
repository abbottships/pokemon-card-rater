// Stage 1: find the card in a frame and cut it out.
// Classic computer vision only (edges -> contours -> four-sided shape). No model yet.
// The point of v0 is to measure where this breaks before reaching for one.
//
// The core functions work on OpenCV Mats so they run the same in the browser and
// in Node tests. findCard / warpCard are the thin canvas wrappers the page uses.

// A trading card is 63 x 88 mm.
export const CARD_RATIO = 88 / 63;
export const CROP_W = 630;
export const CROP_H = 880;

const DETECT_WIDTH = 640;       // detection runs on a downscaled frame for speed
const MIN_AREA_FRACTION = 0.05; // ignore shapes smaller than 5% of the frame
const RATIO_TOLERANCE = 0.25;   // perspective skews the ratio, so be generous

/**
 * Find the most likely card in an RGBA image.
 * @param {any} cv OpenCV.js module
 * @param {any} rgba cv.Mat (CV_8UC4) at any resolution
 * @param {(edges: any) => void} [onEdges] called with the edge map (for debugging)
 * @returns {{corners: number[][], method: 'quad'|'hull', score: number} | null}
 *   corners in the input's pixels, clockwise, first edge a short (top) edge
 */
export function detectCard(cv, rgba, onEdges) {
  const scale = DETECT_WIDTH / rgba.cols;
  const small = new cv.Mat();
  const blurred = new cv.Mat();
  const channels = new cv.MatVector();
  const channelEdges = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);

  try {
    cv.resize(rgba, small, new cv.Size(DETECT_WIDTH, Math.round(rgba.rows * scale)), 0, 0, cv.INTER_AREA);
    cv.GaussianBlur(small, blurred, new cv.Size(5, 5), 0);
    cv.split(blurred, channels);

    // Edge strength varies a lot between photos, so try a couple of Canny thresholds
    // and keep the best candidate across them.
    let best = null;
    for (const [lo, hi] of CANNY_THRESHOLDS) {
      // Edges from each colour channel, combined. A yellow card on a beige desk can be
      // nearly invisible in greyscale but still stands out in the blue channel.
      edges.create(small.rows, small.cols, cv.CV_8U);
      edges.setTo(new cv.Scalar(0));
      for (let ch = 0; ch < 3; ch++) {
        const channel = channels.get(ch);
        cv.Canny(channel, channelEdges, lo, hi);
        channel.delete();
        cv.bitwise_or(edges, channelEdges, edges);
      }
      // Close small gaps in the border (glare, rounded corners).
      cv.dilate(edges, edges, kernel);
      if (lo === CANNY_THRESHOLDS[0][0]) onEdges?.(edges);
      const found = bestQuad(cv, edges);
      if (found && (!best || found.score > best.score)) best = found;
    }

    if (!best) return null;
    best.corners = toPortrait(best.corners).map(([x, y]) => [x / scale, y / scale]);
    return best;
  } finally {
    small.delete(); blurred.delete(); channels.delete(); channelEdges.delete();
    edges.delete(); kernel.delete();
  }
}

const CANNY_THRESHOLDS = [[40, 120], [60, 180]];

// Look at every contour, not just the outermost ones: when a card is held in a hand,
// its outline merges with the fingers, and the clean card shape is an inner contour.
function bestQuad(cv, edges) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const frameArea = edges.cols * edges.rows;
    let best = null;

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      const candidate = area >= MIN_AREA_FRACTION * frameArea ? quadFromContour(cv, c) : null;
      c.delete();
      if (!candidate || !insideFrame(candidate.points, edges.cols, edges.rows)) continue;

      const ordered = orderCorners(candidate.points);
      const ratioError = Math.abs(longShortRatio(ordered) - CARD_RATIO) / CARD_RATIO;
      if (ratioError > RATIO_TOLERANCE) continue;

      // Prefer big shapes with a card-like ratio; a clean outline beats a fitted hull.
      const score = (area / frameArea) * (1 - ratioError) * candidate.weight;
      if (!best || score > best.score) best = { corners: ordered, method: candidate.method, score };
    }
    return best;
  } finally {
    contours.delete(); hierarchy.delete();
  }
}

// A card must be fully in shot; shapes touching the frame edge are usually background.
function insideFrame(points, w, h, margin = 3) {
  return points.every(([x, y]) => x > margin && y > margin && x < w - margin && y < h - margin);
}

/**
 * Straighten the card into a fixed-size portrait crop and measure its sharpness.
 * @returns {{crop: any, sharpness: number}} crop is a new Mat the caller must delete;
 *   sharpness is the variance of the Laplacian (higher is sharper)
 */
export function warpToCrop(cv, rgba, corners) {
  const crop = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CROP_W, 0, CROP_W, CROP_H, 0, CROP_H]);
  const m = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(rgba, crop, m, new cv.Size(CROP_W, CROP_H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return { crop, sharpness: sharpness(cv, crop) };
  } finally {
    from.delete(); to.delete(); m.delete();
  }
}

// --- Canvas wrappers used by the page ---

export function findCard(cv, frame, debugCanvas = null) {
  const rgba = cv.imread(frame);
  try {
    return detectCard(cv, rgba, debugCanvas ? (edges) => cv.imshow(debugCanvas, edges) : undefined);
  } finally {
    rgba.delete();
  }
}

export function warpCard(cv, frame, corners, out) {
  const rgba = cv.imread(frame);
  const { crop, sharpness } = warpToCrop(cv, rgba, corners);
  try {
    cv.imshow(out, crop);
    return sharpness;
  } finally {
    rgba.delete(); crop.delete();
  }
}

// --- Geometry helpers (exported for tests) ---

// A clean outline simplifies to four convex points. If it doesn't (a finger over an
// edge, a dent from glare), fit the convex hull and simplify harder until it does.
function quadFromContour(cv, contour) {
  const approx = new cv.Mat();
  const hull = new cv.Mat();
  const points = (m) => [0, 1, 2, 3].map((k) => [m.data32S[2 * k], m.data32S[2 * k + 1]]);
  try {
    cv.approxPolyDP(contour, approx, 0.02 * cv.arcLength(contour, true), true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      return { points: points(approx), method: 'quad', weight: 1 };
    }
    cv.convexHull(contour, hull, false, true);
    const peri = cv.arcLength(hull, true);
    for (const eps of [0.02, 0.03, 0.04, 0.06, 0.08]) {
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows === 4) return { points: points(approx), method: 'hull', weight: 0.8 };
      if (approx.rows < 4) break;
    }
    return null;
  } finally {
    approx.delete(); hull.delete();
  }
}

// Order clockwise starting nearest the top-left: top-left, top-right, bottom-right, bottom-left.
// Sorting by angle around the centre still works when the card is tilted near 45 degrees.
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const clockwise = [...pts].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (clockwise[i][0] + clockwise[i][1] < clockwise[start][0] + clockwise[start][1]) start = i;
  }
  return [0, 1, 2, 3].map((i) => clockwise[(start + i) % 4]);
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function longShortRatio([tl, tr, br, bl]) {
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const h = (dist(tl, bl) + dist(tr, br)) / 2;
  return Math.max(w, h) / Math.max(1, Math.min(w, h));
}

// If the card is held sideways, rotate the corner order so the crop comes out portrait.
// It may come out upside down; later stages will need to handle that.
export function toPortrait(corners) {
  const [tl, tr, br, bl] = corners;
  return dist(tl, tr) > dist(tl, bl) ? [bl, tl, tr, br] : corners;
}

function sharpness(cv, rgba) {
  const gray = new cv.Mat();
  const lap = new cv.Mat();
  const mean = new cv.Mat();
  const std = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, std);
    return std.data64F[0] ** 2;
  } finally {
    gray.delete(); lap.delete(); mean.delete(); std.delete();
  }
}
