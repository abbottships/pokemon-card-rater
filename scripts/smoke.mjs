// Smoke test: load the real page in headless Chromium with a photo as the camera,
// and check it captures a card.
//
//   npm run smoke -- [image] [--cdn]
//
// By default OpenCV.js is served from node_modules so the run works offline.
// --cdn loads it from the URL in index.html instead.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname;
const OUTPUT = join(ROOT, 'tests/output');
const args = process.argv.slice(2);
const useCdn = args.includes('--cdn');
const imagePath = args.find((a) => !a.startsWith('--'));
const TIMEOUT_MS = 30000;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
};

// Static file server for the repo.
const server = createServer((req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  const file = path.endsWith('/') ? join(path, 'index.html') : path;
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const image = imagePath
  ? `data:${TYPES[extname(imagePath).toLowerCase()]};base64,${readFileSync(imagePath).toString('base64')}`
  : null;

// CHROMIUM_PATH lets you use an existing Chromium instead of Playwright's download.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

if (!useCdn) {
  const local = join(ROOT, 'node_modules/@techstark/opencv-js/dist/opencv.js');
  // Only the CDN copy: the page's own src/opencv.js loader must not be swapped out.
  await page.route((u) => u.hostname !== 'localhost' && u.pathname.endsWith('/opencv.js'), (route) => route.fulfill({ path: local, contentType: 'text/javascript' }));
}

// Replace the camera with a canvas that shows the image (or a drawn stand-in card)
// letterboxed into a 1280x720 frame, like a webcam would.
await page.addInitScript((src) => {
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#7a7a72';
    ctx.fillRect(0, 0, 1280, 720);
    if (src) {
      const img = new Image();
      img.src = src;
      await img.decode();
      const s = Math.min(1280 / img.width, 720 / img.height);
      const w = img.width * s, h = img.height * s;
      ctx.drawImage(img, (1280 - w) / 2, (720 - h) / 2, w, h);
    } else {
      ctx.translate(640, 360);
      ctx.rotate(0.15);
      ctx.fillStyle = '#f5cd28'; ctx.fillRect(-160, -224, 320, 448);
      ctx.fillStyle = '#e8e4d7'; ctx.fillRect(-142, -206, 284, 412);
      ctx.fillStyle = '#4682c8'; ctx.fillRect(-130, -170, 260, 170);
      // Lines of "text", so the crop has enough detail to pass the sharpness check.
      ctx.fillStyle = '#333';
      for (let y = 20; y < 190; y += 14) ctx.fillRect(-125, y, 180 + ((y * 7) % 60), 5);
    }
    // Keep repainting so the stream keeps producing frames.
    const frame = ctx.getImageData(0, 0, 1280, 720);
    setInterval(() => ctx.putImageData(frame, 0, 0), 33);
    return canvas.captureStream(30);
  };
}, image);

const started = Date.now();
await page.goto(url);
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Ready'), null, { timeout: TIMEOUT_MS });
const loadSeconds = (Date.now() - started) / 1000;
await page.click('#start');
await page
  .waitForFunction(() => Number(document.getElementById('m-captures').textContent) > 0, null, { timeout: TIMEOUT_MS })
  .catch(() => {});

const metrics = await page.evaluate(() =>
  Object.fromEntries(['status', 'm-detect', 'm-stable', 'm-sharp', 'm-captures']
    .map((id) => [id, document.getElementById(id).textContent])));
mkdirSync(OUTPUT, { recursive: true });
await page.screenshot({ path: join(OUTPUT, 'smoke.png') });
await browser.close();
server.close();

console.log(`OpenCV ready in ${loadSeconds.toFixed(1)}s (${useCdn ? 'CDN' : 'local'})`);
for (const [k, v] of Object.entries(metrics)) console.log(`${k.replace('m-', '')}: ${v}`);
console.log('screenshot: tests/output/smoke.png');
if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`);

const ok = Number(metrics['m-captures']) > 0 && errors.length === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
