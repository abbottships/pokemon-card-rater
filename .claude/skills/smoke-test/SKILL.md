---
name: smoke-test
description: Check the real card scanner page end to end in headless Chromium, feeding a photo in as the camera. Use after changing the page, src/main.js, the OpenCV loading, or before saying a change works.
---

# Smoke test the page

Unit tests cover `src/detect.js` in Node. This covers what they can't: OpenCV.js loading from the CDN, the camera path, the frame loop, the gate and the overlay.

1. One-time setup: `npm install`, then `npx playwright install chromium` if Playwright has no browser.
2. Run `npm run smoke -- <image>`, where `<image>` is a photo of a card (e.g. something in `tests/fixtures/photos/`). Without an argument it uses a drawn stand-in card.
3. The script serves the repo, opens the page, replaces the camera with the image, clicks Start, and waits for a capture. It prints the status line and metrics (detect time, stable frames, sharpness, captures) and saves `tests/output/smoke.png`.
4. Look at `tests/output/smoke.png`. The green outline should sit on the card, and the "Last captured card" panel should show it straightened and upright (or upside down, which is a known gap).
5. It passes if captures ≥ 1 and there are no page errors. Report the detect time too, since it's the number that matters on a phone.

If OpenCV.js never loads, check the CDN URL in `index.html` and whether `src/opencv.js` still deletes the module's `.then` before resolving.
