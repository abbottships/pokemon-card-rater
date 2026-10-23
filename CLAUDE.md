# CLAUDE.md

In-browser Pokémon card scanner. Point a camera at a card, and it finds the card, cuts it out, and (in later versions) identifies, grades and prices it, then recommends keep, sell or grade. It's also a public demo of the "System 1" idea: small fast models that each answer one question with a confidence score, escalating to an LLM only when unsure.

## Commands

```sh
npm install             # OpenCV.js (Node build) and sharp, for tests only
npm test                # node:test, all suites, ~3s
npm run fixtures        # download a few stock card scans into tests/fixtures/cards
npm run smoke -- <img>  # load the real page in headless Chromium with <img> as the camera
npm start               # serve the page on http://localhost:8000
```

The page itself has no build step and no bundler. It's plain ES modules plus OpenCV.js from a CDN.

## Layout

| Path | Role |
| --- | --- |
| `index.html`, `style.css` | The page |
| `src/main.js` | Camera, frame loop, overlay, `onCardCaptured` hand-off to later stages |
| `src/detect.js` | Stage 1: `detectCard` (find corners) and `warpToCrop` (630×880 crop + sharpness). Mat-based, so it runs in the browser and in Node |
| `src/gate.js` | `CaptureGate`: capture once when the card is steady and sharp |
| `src/opencv.js` | Waits for OpenCV.js to load |
| `tests/` | Geometry, synthetic-scene and real-photo tests, plus helpers |
| `scripts/` | Fixture download and headless smoke test |

## Pipeline (current and planned)

1. **Find** (v0, done): classic CV, no model. Colour Canny, all contours, quad or convex-hull fit, card-ratio check.
2. **Identify** (v1): name/set via image embedding lookup, number via OCR of the bottom strip, rarity symbol classifier, price from pokemontcg.io.
3. **Condition** (v2): centring, corners, edges.
4. **Decide** (v3): keep, sell or grade from expected graded value vs raw price.

Every stage after Find should return `{ value, confidence }` and run in the browser (ONNX Runtime Web / transformers.js, WebGPU with WASM fallback). Low confidence escalates rather than guesses. Log how often each stage escalates, because that number is the point of the project.

## Conventions

- Keep detection logic in Mat-based functions in `src/detect.js` (like `detectCard`, `warpToCrop`). Canvas wrappers stay thin. This is what lets Node tests exercise the real code.
- Delete every `cv.Mat` / `cv.MatVector` you create (`try/finally`), including Mats returned by `MatVector.get()`. Leaks in the frame loop kill mobile Safari.
- The OpenCV.js module is a thenable that resolves to itself: never `await` it or resolve a Promise with it without deleting `.then` first (see `src/opencv.js`). Doing so freezes the page.
- Tests use Node's built-in runner (`node:test`, `node:assert/strict`). No Jest, no TypeScript.
- Synthetic tests are seeded. When one fails, the seed is in the message and the scene is saved to `tests/output/`. Look at the image before changing code.
- Match the existing style: small modules, comments that explain *why*, no frameworks.

## Rules

- **Don't loosen a test tolerance or drop a case to make tests pass.** If a change trades accuracy for something else, say so and report the numbers before and after.
- **Card images and photos are gitignored.** Card scans are copyrighted, and photos from the internet belong to whoever took them. Only `tests/fixtures/photos/labels.json` is committed. A photo goes in the repo only if the owner of this repo took it and says so.
- This is a public repo. Never put employer names, work details or prompt text in files, commits, issues or PRs.
- Before calling something done: `npm test` passes, and for anything touching the page, `npm run smoke` captures a card.

## Skills

Repo skills live in `.claude/skills/`:
- `test-and-tune`: run the tests, read the failures and output images, tune the detector honestly.
- `add-photo-fixture`: turn a new photo into a real-world test with marked corners.
- `smoke-test`: check the real page end to end in headless Chromium.
