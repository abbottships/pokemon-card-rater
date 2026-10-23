---
name: test-and-tune
description: Run the card scanner tests, diagnose failures from the saved output images, and tune the detector without hiding regressions. Use when tests fail, after changing src/detect.js or src/gate.js, or when asked to improve detection.
---

# Test and tune the detector

1. Run `npm test`. If `node_modules` is missing, run `npm install` first.
2. Record the baseline before changing anything:
   - pass/fail counts
   - the `clutter hit rate: N/10` diagnostic for each card
   - the `corner error X% via quad|hull` diagnostic for each real photo
3. For each failure:
   - Read the seed and the case (card, background, pose) from the message.
   - Open the saved image in `tests/output/` (`miss-*.png` for a missed scene, `crop-*.png` for a wrong crop, `photo-crop-*.png` for real photos). Look at it before guessing.
   - To see what the detector sees, call `detectCard(cv, img, edges => ...)` in a short script and save the edge map with `writeImage` from `tests/helpers.mjs`.
4. Tune in `src/detect.js`. These are the levers, roughly in order of how often they matter:
   - `CANNY_THRESHOLDS`: edge sensitivity (lower finds faint edges and more noise)
   - `DETECT_WIDTH`: detection resolution (higher helps small cards and costs time)
   - `MIN_AREA_FRACTION`, `RATIO_TOLERANCE`: what counts as a candidate
   - the hull simplification steps in `quadFromContour`
5. Rerun `npm test` and compare against the baseline. Also check detection time. Each frame should stay well under 50 ms; `npm run smoke` prints it.
6. Report the numbers before and after in a small table. Say plainly if anything got worse.

Never change `MAX_CORNER_ERROR`, `MIN_SIMILARITY` or the test cases just to get to green. If a tolerance is genuinely wrong, explain why and ask first.
