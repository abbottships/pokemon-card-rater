---
name: add-photo-fixture
description: Add a real photo of a card as a test case, with hand-checked corner labels in tests/fixtures/photos/labels.json. Use when the user shares a card photo to test against.
---

# Add a real photo as a test

1. Save the photo to `tests/fixtures/photos/<short-kebab-name>.<ext>` (`.jpg`, `.png` or `.webp`). Name it after the card and the situation, e.g. `charizard-in-hand.webp`.
2. Get the image size (`node -e "require('sharp')('<path>').metadata().then(m => console.log(m.width, m.height))"`).
3. Mark the four outer corners of the card: the physical card edge, not the inner yellow border. Use pixel coordinates, clockwise from the card's top-left as the card reads.
   - Get a first guess by running `detectCard` on the photo, or by eye.
   - Check each corner by cropping about 100×100 px around it, scaling it up, and looking at it. Adjust until each point sits on the corner to within a few pixels. For a rounded corner, use where the two straight edges would meet.
4. Add an entry to `tests/fixtures/photos/labels.json`:
   ```json
   "<file name>": {
     "corners": [[x, y], [x, y], [x, y], [x, y]],
     "notes": "what makes this photo hard: hand, glare, background, angle"
   }
   ```
5. Run `npm test`. Report the `corner error` diagnostic and look at `tests/output/photo-crop-<name>.png`. A failing new photo is a useful result: keep the label, report the failure, and use the test-and-tune skill to work on it if asked.
6. Committing: photos are gitignored. Commit only the `labels.json` change. Commit the photo itself only if the repo owner took it and says it can go in. In that case, add a `!tests/fixtures/photos/<file>` line to `.gitignore`.
