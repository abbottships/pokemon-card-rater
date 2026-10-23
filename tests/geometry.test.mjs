// Pure-JS tests for the corner maths and the capture gate (no OpenCV needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderCorners, toPortrait, longShortRatio, CARD_RATIO } from '../src/detect.js';
import { CaptureGate } from '../src/gate.js';

const portrait = [[100, 100], [163, 100], [163, 188], [100, 188]]; // tl, tr, br, bl

test('orderCorners returns tl, tr, br, bl from any input order', () => {
  const shuffled = [portrait[2], portrait[0], portrait[3], portrait[1]];
  assert.deepEqual(orderCorners(shuffled), portrait);
});

test('orderCorners handles a card tilted to 45 degrees', () => {
  const diamond = [[200, 100], [300, 200], [200, 300], [100, 200]];
  const ordered = orderCorners([diamond[3], diamond[1], diamond[0], diamond[2]]);
  // Clockwise on screen, starting with the corner nearest the top-left.
  assert.deepEqual(ordered, [[200, 100], [300, 200], [200, 300], [100, 200]]);
});

test('longShortRatio of a card is 88/63', () => {
  assert.ok(Math.abs(longShortRatio(portrait) - CARD_RATIO) < 0.01);
});

test('toPortrait leaves an upright card alone', () => {
  assert.deepEqual(toPortrait(portrait), portrait);
});

test('toPortrait rotates a sideways card so the first edge is short', () => {
  const sideways = [[100, 100], [188, 100], [188, 163], [100, 163]];
  const [a, b, , d] = toPortrait(sideways);
  const top = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const left = Math.hypot(a[0] - d[0], a[1] - d[1]);
  assert.ok(top < left);
});

test('gate captures once after the card holds still, then waits for it to leave', () => {
  const gate = new CaptureGate({ stableFrames: 3, rearmAfterMissing: 2 });
  const ready = [];
  for (let i = 0; i < 6; i++) ready.push(gate.update(portrait, 1280, 720));
  assert.deepEqual(ready, [false, false, false, true, true, true]);

  assert.equal(gate.accept(500), true);
  assert.equal(gate.update(portrait, 1280, 720), false, 'no second capture of the same card');

  gate.update(null, 1280, 720);
  gate.update(null, 1280, 720);
  assert.equal(gate.armed, true, 're-armed once the card has gone');
});

test('gate resets when the card moves', () => {
  const gate = new CaptureGate({ stableFrames: 2 });
  gate.update(portrait, 1280, 720);
  gate.update(portrait, 1280, 720);
  const moved = portrait.map(([x, y]) => [x + 60, y]);
  gate.update(moved, 1280, 720);
  assert.equal(gate.stable, 0);
});

test('gate rejects a blurry crop and stays armed', () => {
  const gate = new CaptureGate({ minSharpness: 100 });
  assert.equal(gate.accept(20), false);
  assert.equal(gate.armed, true);
});
