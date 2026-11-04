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
// Margin kept around the card in the crop (each side, in crop pixels: about 2.5 mm).
// Detection can land on the inside of a border that blends into the background, and
// later stages (edges, corners, centring) need to see the card's edges, so cut wide.
export const CROP_PAD = 25;

const DETECT_SIZE = 640;        // detection runs on a downscaled frame (long side) for speed
const MIN_AREA_FRACTION = 0.05; // ignore shapes smaller than 5% of the frame
const RATIO_TOLERANCE = 0.25;   // perspective skews the ratio, so be generous
const MAX_ANGLE_ERROR = 20;     // degrees a corner may be off square (perspective, hand tilt)
const MIN_SIDE_SUPPORT = 0.5;   // each side: fraction of it that must lie on an edge
const MIN_SUPPORT = 0.7;        // whole outline: mean of the four sides
const MAX_LINES = 24;           // longest merged lines considered when pairing sides

/**
 * Find the most likely card in an RGBA image.
 * @param {any} cv OpenCV.js module
 * @param {any} rgba cv.Mat (CV_8UC4) at any resolution
 * @param {(edges: any) => void} [onEdges] called with the edge map (for debugging)
 * @returns {{corners: number[][], method: 'quad'|'hull'|'lines', score: number, support: number} | null}
 *   corners in the input's pixels, clockwise, first edge a short (top) edge
 */
export function detectCard(cv, rgba, onEdges) {
  // Scale by the long side, so a portrait phone frame costs the same as a landscape one.
  const scale = DETECT_SIZE / Math.max(rgba.cols, rgba.rows);
  const small = new cv.Mat();
  const blurred = new cv.Mat();
  const channels = new cv.MatVector();
  const channelEdges = new cv.Mat();
  const edges = new cv.Mat();
  const thin = new cv.Mat();
  const near = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);

  try {
    cv.resize(rgba, small, new cv.Size(Math.round(rgba.cols * scale), Math.round(rgba.rows * scale)), 0, 0, cv.INTER_AREA);
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
      edges.copyTo(thin);
      // Close small gaps in the border (glare, rounded corners).
      cv.dilate(edges, edges, kernel);
      if (lo === CANNY_THRESHOLDS[0][0]) onEdges?.(edges);
      // A slightly wider edge map for checking a side lies on an edge: blur and the
      // 640px downscale can put a real edge a pixel or two off the fitted line.
      cv.dilate(edges, near, kernel);
      // Line finding is the slow part, so it runs on the first (more sensitive) pass only.
      const first = lo === CANNY_THRESHOLDS[0][0];
      const candidates = [...contourCandidates(cv, edges), ...(first ? lineCandidates(cv, thin) : [])];
      const found = pickCard(candidates, near);
      if (found && (!best || found.score > best.score)) {
        best = { ...found, corners: refineCorners(edges, snapOutward(near, found.corners)) };
      }
    }

    if (!best) return null;
    best.corners = toPortrait(best.corners).map(([x, y]) => [x / scale, y / scale]);
    return best;
  } finally {
    small.delete(); blurred.delete(); channels.delete(); channelEdges.delete();
    edges.delete(); thin.delete(); near.delete(); kernel.delete();
  }
}

const CANNY_THRESHOLDS = [[40, 120], [60, 180]];

// Look at every contour, not just the outermost ones: when a card is held in a hand,
// its outline merges with the fingers, and the clean card shape is an inner contour.
function contourCandidates(cv, edges) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const out = [];
  try {
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const frameArea = edges.cols * edges.rows;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const candidate = cv.contourArea(c) >= MIN_AREA_FRACTION * frameArea ? quadFromContour(cv, c) : null;
      c.delete();
      if (candidate) out.push(candidate);
    }
    return out;
  } finally {
    contours.delete(); hierarchy.delete();
  }
}

// The card's sides are straight lines even when its outline is broken: a thumb over one
// edge, a border the same colour as the wall behind it, glare on a sleeve. Find long
// straight segments, merge the collinear ones, and try every pair of roughly parallel
// lines against every other such pair that crosses it at roughly a right angle.
function lineCandidates(cv, edges) {
  const minSide = Math.min(edges.cols, edges.rows);
  const raw = new cv.Mat();
  const segments = [];
  try {
    cv.HoughLinesP(edges, raw, 1, Math.PI / 180, 40, minSide * 0.12, 6);
    for (let i = 0; i < raw.rows; i++) {
      const [x1, y1, x2, y2] = raw.data32S.subarray(i * 4, i * 4 + 4);
      segments.push({ a: [x1, y1], b: [x2, y2], len: Math.hypot(x2 - x1, y2 - y1) });
    }
  } finally {
    raw.delete();
  }

  const lines = mergeSegments(segments).slice(0, MAX_LINES);
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (angleBetween(lines[i].theta, lines[j].theta) > 12) continue;
      if (distanceToLine(lines[i], lines[j].mid) < minSide * 0.15) continue;
      pairs.push([lines[i], lines[j]]);
    }
  }

  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [a, b] = pairs[i], [c, d] = pairs[j];
      if (Math.abs(angleBetween(a.theta, c.theta) - 90) > 25) continue;
      const points = [intersect(a, c), intersect(c, b), intersect(b, d), intersect(d, a)];
      if (points.some((p) => !p)) continue;
      out.push({ points, method: 'lines', weight: 1 });
    }
  }
  return out;
}

// Collinear segments (same direction, same offset) are one line, e.g. a card edge broken
// by a finger. Longest first, so each merged line keeps its longest segment's geometry.
// A line is ranked by how much of it is covered by segments, not their summed length:
// texture (wood grain, sensor noise) gives many overlapping short segments on one line.
function mergeSegments(segments) {
  const lines = [];
  for (const s of segments.sort((p, q) => q.len - p.len)) {
    const theta = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
    const mid = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    let line = lines.find((l) => angleBetween(l.theta, theta) < 3 && distanceToLine(l, mid) < 5);
    if (!line) {
      const n = [-Math.sin(theta), Math.cos(theta)];
      line = { theta, n, rho: n[0] * mid[0] + n[1] * mid[1], mid, spans: [] };
      lines.push(line);
    }
    const along = (p) => p[0] * line.n[1] - p[1] * line.n[0];
    const [t1, t2] = [along(s.a), along(s.b)].sort((p, q) => p - q);
    line.spans.push([t1, t2]);
  }
  for (const l of lines) l.len = covered(l.spans);
  return lines.sort((p, q) => q.len - p.len);
}

// Total length of the union of 1D intervals.
function covered(spans) {
  let total = 0, end = -Infinity;
  for (const [a, b] of spans.sort((p, q) => p[0] - q[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

// Angle between two undirected lines, in degrees (0 to 90).
function angleBetween(t1, t2) {
  let d = Math.abs(t1 - t2) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return (d * 180) / Math.PI;
}

function distanceToLine(line, p) {
  return Math.abs(line.n[0] * p[0] + line.n[1] * p[1] - line.rho);
}

function intersect(l1, l2) {
  const det = l1.n[0] * l2.n[1] - l1.n[1] * l2.n[0];
  if (Math.abs(det) < 1e-6) return null;
  return [(l1.rho * l2.n[1] - l1.n[1] * l2.rho) / det, (l1.n[0] * l2.rho - l1.rho * l2.n[0]) / det];
}

// Keep only shapes that could be a card, then take the outermost. A card's printed
// frames (the inside of the border, the art box, the text box) are card-shaped too and
// often have cleaner edges than the card itself, so the biggest valid shape wins and
// edge support only breaks near-ties.
// The cost: a card inside something card-shaped and bigger (a photo, a picture frame,
// a toploader) gets that thing's outline. Tracked as a measured case in the tests.
function pickCard(candidates, near) {
  const frameArea = near.cols * near.rows;
  const valid = [];
  for (const { points, method, weight } of candidates) {
    if (!insideFrame(points, near.cols, near.rows)) continue;
    const ordered = orderCorners(points);
    if (!isConvex(ordered)) continue;
    const area = polygonArea(ordered);
    if (area < MIN_AREA_FRACTION * frameArea) continue;
    const ratioError = Math.abs(longShortRatio(ordered) - CARD_RATIO) / CARD_RATIO;
    if (ratioError > RATIO_TOLERANCE) continue;
    if (maxAngleError(ordered) > MAX_ANGLE_ERROR) continue;
    const sides = sideSupport(near, ordered);
    const support = sides.reduce((s, v) => s + v, 0) / 4;
    if (Math.min(...sides) < MIN_SIDE_SUPPORT || support < MIN_SUPPORT) continue;

    const score = (area / frameArea) * (0.9 + 0.1 * support) * (1 - ratioError / 4) * weight;
    valid.push({ corners: ordered, method, score, support });
  }
  if (!valid.length) return null;
  const { corners, method, score, support } = valid.reduce((p, q) => (q.score > p.score ? q : p));
  return { corners, method, score, support };
}

// The outline found can be the inside of the card's border on one or more sides: the
// border may blend into the background while the print inside it has crisp edges. Move
// each side out to the outermost parallel edge within about a border's width (6% of
// the card's short side), so the crop includes the whole card.
function snapOutward(map, corners) {
  const cx = corners.reduce((s, p) => s + p[0], 0) / 4;
  const cy = corners.reduce((s, p) => s + p[1], 0) / 4;
  const [tl, tr, br, bl] = corners;
  const short = Math.min((dist(tl, tr) + dist(bl, br)) / 2, (dist(tl, bl) + dist(tr, br)) / 2);
  const reach = Math.max(3, Math.round(short * 0.06));
  const sides = corners.map((a, i) => {
    const b = corners[(i + 1) % 4];
    const len = dist(a, b);
    let n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    if (n[0] * ((a[0] + b[0]) / 2 - cx) + n[1] * ((a[1] + b[1]) / 2 - cy) < 0) n = [-n[0], -n[1]];
    // Offsets (outward) at which a parallel side would lie on an edge. The last run of
    // them is the outermost edge; its middle is where that edge is.
    let runStart = 0, runEnd = 0, inRun = false;
    for (let d = 0; d <= reach; d++) {
      const shifted = [[a[0] + n[0] * d, a[1] + n[1] * d], [b[0] + n[0] * d, b[1] + n[1] * d]];
      if (segmentSupport(map, shifted[0], shifted[1], 0.15, 0.85) >= 0.6) {
        if (!inRun) { runStart = d; inRun = true; }
        runEnd = d;
      } else {
        inRun = false;
      }
    }
    const d = (runStart + runEnd) / 2;
    const p = [a[0] + n[0] * d, a[1] + n[1] * d];
    const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const nn = [-Math.sin(theta), Math.cos(theta)];
    return { theta, n: nn, rho: nn[0] * p[0] + nn[1] * p[1], mid: p };
  });
  return corners.map((c, i) => intersect(sides[(i + 3) % 4], sides[i]) ?? c);
}

// Card corners are rounded, so a contour's corner points sit inside the card's real
// (square) corners, and a fitted side can be a pixel or two off. Fit a straight line to
// the edge pixels along the middle of each side and intersect neighbouring sides: that
// gives the corners of the 63 x 88 mm rectangle the card is measured by.
function refineCorners(edges, corners, band = 4) {
  const { cols, rows, data } = edges;
  const lines = corners.map((a, i) => {
    const b = corners[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const pts = [];
    for (let s = len * 0.12; s <= len * 0.88; s += 1) {
      const t = s / len;
      for (let o = -band; o <= band; o++) {
        const x = Math.round(a[0] + (b[0] - a[0]) * t + n[0] * o);
        const y = Math.round(a[1] + (b[1] - a[1]) * t + n[1] * o);
        if (x >= 0 && y >= 0 && x < cols && y < rows && data[y * cols + x]) pts.push([x, y]);
      }
    }
    return pts.length >= len * 0.3 ? fitLine(pts) : null;
  });
  return corners.map((c, i) => {
    const prev = lines[(i + 3) % 4], next = lines[i];
    const p = prev && next ? intersect(prev, next) : null;
    // Keep the original corner if a side had too few edge pixels or the fit went wild.
    return p && Math.hypot(p[0] - c[0], p[1] - c[1]) < band * 3 ? p : c;
  });
}

// Total least squares line through points, in the same form as the Hough lines.
function fitLine(pts) {
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const n = [-Math.sin(theta), Math.cos(theta)];
  return { theta, n, rho: n[0] * mx + n[1] * my, mid: [mx, my] };
}

// Fraction of each side that lies on an edge pixel. The ends are skipped: card corners
// are rounded, so the outline leaves the fitted straight side there.
function sideSupport(map, corners) {
  return corners.map((a, i) => segmentSupport(map, a, corners[(i + 1) % 4], 0.08, 0.92));
}

function segmentSupport(map, a, b, from, to, samples = 40) {
  const { cols, rows, data } = map;
  let hits = 0;
  for (let k = 0; k < samples; k++) {
    const t = from + ((to - from) * k) / (samples - 1);
    const x = Math.round(a[0] + (b[0] - a[0]) * t);
    const y = Math.round(a[1] + (b[1] - a[1]) * t);
    if (x >= 0 && y >= 0 && x < cols && y < rows && data[y * cols + x]) hits++;
  }
  return hits / samples;
}

function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Largest deviation from 90 degrees over the four corners. */
export function maxAngleError(corners) {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const p = corners[(i + 3) % 4], q = corners[i], r = corners[(i + 1) % 4];
    const u = [p[0] - q[0], p[1] - q[1]], v = [r[0] - q[0], r[1] - q[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v));
    worst = Math.max(worst, Math.abs((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI - 90));
  }
  return worst;
}

// A card must be fully in shot; shapes touching the frame edge are usually background.
function insideFrame(points, w, h, margin = 3) {
  return points.every(([x, y]) => x > margin && y > margin && x < w - margin && y < h - margin);
}

/**
 * Straighten the card into a fixed-size portrait crop, with a margin of `pad` pixels
 * of the surrounding frame on every side, and measure the card's sharpness.
 * @returns {{crop: any, sharpness: number}} crop is a new Mat ((CROP_W + 2 pad) x
 *   (CROP_H + 2 pad)) the caller must delete; sharpness is the variance of the Laplacian
 *   at the card's own resolution in the frame (higher is sharper)
 */
export function warpToCrop(cv, rgba, corners, pad = CROP_PAD) {
  const crop = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [pad, pad, pad + CROP_W, pad, pad + CROP_W, pad + CROP_H, pad, pad + CROP_H]);
  const m = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(rgba, crop, m, new cv.Size(CROP_W + 2 * pad, CROP_H + 2 * pad), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return { crop, sharpness: nativeSharpness(cv, rgba, corners) };
  } finally {
    from.delete(); to.delete(); m.delete();
  }
}

// Sharpness has to be measured at the card's size in the frame. Upscaling a small card
// (a laptop webcam at arm's length gives ~250 px across) to 630 px wide smooths it, and
// the Laplacian then reads it as blurry however well focused it is.
function nativeSharpness(cv, rgba, corners) {
  const [tl, tr, br, bl] = corners;
  const width = (dist(tl, tr) + dist(bl, br)) / 2;
  const k = Math.min(1, width / CROP_W);
  const w = Math.max(32, Math.round(CROP_W * k)), h = Math.max(32, Math.round(CROP_H * k));
  const card = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const m = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(rgba, card, m, new cv.Size(w, h), cv.INTER_AREA, cv.BORDER_REPLICATE);
    return sharpness(cv, card);
  } finally {
    card.delete(); from.delete(); to.delete(); m.delete();
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
