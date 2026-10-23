import { loadOpenCv } from './opencv.js';
import { findCard, warpCard } from './detect.js';
import { CaptureGate } from './gate.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const crop = $('crop');
const status = $('status');
const startBtn = $('start');
const flipBtn = $('flip');
const debugBox = $('debug');

const frame = document.createElement('canvas'); // full-resolution copy of the current frame
frame.getContext('2d', { willReadFrequently: true });
const debugEdges = document.createElement('canvas');

let cv = null;
let stream = null;
let facingMode = 'environment';
let captures = 0;
const gate = new CaptureGate();

loadOpenCv()
  .then((m) => { cv = m; status.textContent = 'Ready. Start the camera and hold a card up to it.'; })
  .catch((e) => { status.textContent = e.message; });

startBtn.addEventListener('click', () => startCamera());
flipBtn.addEventListener('click', () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
});

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = 'Camera not available. The page must be served over HTTPS or localhost.';
    return;
  }
  stream?.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    status.textContent = `Camera error: ${e.message}`;
    return;
  }
  video.srcObject = stream;
  await video.play();
  startBtn.textContent = 'Restart camera';
  flipBtn.disabled = false;
  scheduleFrame();
}

function scheduleFrame() {
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame(onFrame);
}

function onFrame() {
  if (!cv || video.readyState < 2) { scheduleFrame(); return; }

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (frame.width !== w || frame.height !== h) {
    frame.width = overlay.width = w;
    frame.height = overlay.height = h;
  }
  frame.getContext('2d').drawImage(video, 0, 0, w, h);

  const t0 = performance.now();
  const card = findCard(cv, frame, debugBox.checked ? debugEdges : null);
  $('m-detect').textContent = `${(performance.now() - t0).toFixed(1)} ms${card ? ` (${card.method})` : ''}`;

  const ready = gate.update(card?.corners ?? null, w, h);
  $('m-stable').textContent = gate.stable;

  let captured = false;
  if (ready) {
    const sharp = warpCard(cv, frame, card.corners, crop);
    $('m-sharp').textContent = sharp.toFixed(0);
    if (gate.accept(sharp)) {
      captured = true;
      captures++;
      $('m-captures').textContent = captures;
      onCardCaptured(crop, card);
    }
  }

  drawOverlay(card, captured);
  scheduleFrame();
}

function drawOverlay(card, captured) {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (debugBox.checked && debugEdges.width) {
    const dw = overlay.width / 4;
    ctx.drawImage(debugEdges, 0, 0, dw, dw * (debugEdges.height / debugEdges.width));
  }
  if (!card) return;

  ctx.lineWidth = Math.max(3, overlay.width / 300);
  ctx.strokeStyle = captured || !gate.armed ? '#4caf50' : '#ffcb05';
  ctx.beginPath();
  card.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
}

// Hand-off point for the next stages (identify, rarity, condition).
// For v0 it only logs; the straightened 630x880 crop is in `cropCanvas`.
function onCardCaptured(cropCanvas, card) {
  status.textContent = `Captured card ${captures} (${card.method}). Take it away to scan the next one.`;
  console.log('card captured', { method: card.method, score: card.score, corners: card.corners });
}
