# Card rater (v0)

A browser app that looks at a Pokémon card held up to a camera and, eventually, tells you whether to keep it, sell it or send it for grading. Everything runs in the browser, so it works on a laptop or a phone.

v0 is stage 1 only: **find the card and cut it out.**

1. The camera feed comes in through `getUserMedia`.
2. OpenCV.js finds edges in each colour channel, then the largest four-sided shape with a card's 63:88 ratio. It looks at inner contours too, because a card held in a hand merges with the fingers. If the outline still isn't a clean quad, it simplifies the convex hull until it is.
3. A gate waits until the card has held still for 8 frames, then straightens it into a 630×880 crop and checks it's sharp.
4. The card is captured once. Take it away (or swap it) to capture the next one.

No models are used yet. That's deliberate: the first job is to measure where classic computer vision is good enough and where it breaks.

## Run it

```sh
cd pokemon-card-rater
python3 -m http.server 8000
```

Open http://localhost:8000, press **Start camera** and hold a card up.

The camera only works over HTTPS or on `localhost`. To try it on a phone, either:
- push it to GitHub Pages, or
- run a tunnel such as `npx localtunnel --port 8000` or `cloudflared tunnel --url http://localhost:8000` and open the HTTPS link on the phone.

## Test it

```sh
npm install
npm test
```

- **Geometry and gate tests** check corner ordering, portrait rotation and the capture gate.
- **Synthetic scene tests** take each card image in `tests/fixtures/cards`, place it on generated backgrounds (plain, noisy, cluttered) at random positions, angles and perspective, and check the detector finds the corners within 4% of the card diagonal and that the crop matches the card. Scenes are seeded, so a failure is reproducible, and missed scenes are saved to `tests/output`. With no card images, a drawn stand-in card is used.
- **Real photo tests** run the detector on photos in `tests/fixtures/photos` and compare against hand-marked corners in `labels.json` (5% tolerance). The crop is saved to `tests/output` so you can look at it.

To get stock card images, run `npm run fixtures` (downloads a few scans from the Pokémon TCG API's image CDN) or drop your own `.png`/`.jpg`/`.webp` scans into `tests/fixtures/cards`. Card images and photos are gitignored because they're copyrighted; only `labels.json` is committed.

Current results: all synthetic scenes pass with the stand-in card, cluttered backgrounds 10/10, and the Charizard-in-hand photo is found with a 3.9% corner error.

## Files

| File | What it does |
| --- | --- |
| `src/main.js` | Camera, the frame loop, drawing the outline, the hand-off to later stages |
| `src/detect.js` | Card detection, corner ordering, perspective warp, sharpness |
| `src/gate.js` | Decides when a card is steady and sharp enough to capture |
| `src/opencv.js` | Waits for OpenCV.js to finish loading |
| `tests/` | Unit, synthetic scene and real photo tests (Node's built-in test runner) |
| `scripts/fetch-fixtures.mjs` | Downloads a few stock card images for the tests |

Tick **Show edges** to see the edge map the detector is working from.

## Tuning

- `findCard` in `src/detect.js`: Canny thresholds (`40, 120`), the detection width (640px), the minimum card size (5% of the frame) and the ratio tolerance (25%).
- `CaptureGate` in `src/gate.js`: number of stable frames, how much movement still counts as still, and the sharpness threshold (80).

## Known gaps

- The crop can come out upside down. Later stages need to handle that (or check which way up the text is).
- On the hand-held photo the outline snaps to the inside of the yellow border on the edges where fingers overlap the card. Fine for identifying the card, not good enough for measuring centring later.
- Busy backgrounds and holo glare will confuse the edge detector. That's the measurement to make before swapping in a small segmentation model.
- OpenCV.js is about 10 MB and takes a few seconds to start, especially on a phone.

## Next

- **v1, identify:** name, set and number (image embedding lookup + OCR on the number), rarity symbol, price from pokemontcg.io.
- **v2, condition:** centring, corners, edges.
- **v3, decide:** keep, sell or grade, with confidence scores and an LLM fallback when unsure.
