// Frame gating: only hand a card to the (later, heavier) models once it has held
// still for a few frames and the crop is sharp. Then wait for the card to leave
// before capturing again, so each card is processed once rather than 30 times a second.

export class CaptureGate {
  constructor({
    stableFrames = 8,       // frames the corners must stay put
    maxMovement = 0.012,    // max corner movement per frame, as a fraction of the frame diagonal
    minSharpness = 80,      // variance of the Laplacian on the crop
    rearmAfterMissing = 10, // frames with no card before the next capture is allowed
  } = {}) {
    Object.assign(this, { stableFrames, maxMovement, minSharpness, rearmAfterMissing });
    this.last = null;
    this.stable = 0;
    this.missing = 0;
    this.armed = true;
  }

  /** Feed the detection for this frame. Returns true when the card is ready to capture. */
  update(corners, frameW, frameH) {
    if (!corners) {
      this.missing++;
      this.stable = 0;
      this.last = null;
      if (this.missing >= this.rearmAfterMissing) this.armed = true;
      return false;
    }

    this.missing = 0;
    const diag = Math.hypot(frameW, frameH);
    const moved = this.last
      ? Math.max(...corners.map((p, i) => Math.hypot(p[0] - this.last[i][0], p[1] - this.last[i][1]))) / diag
      : Infinity;
    this.stable = moved <= this.maxMovement ? this.stable + 1 : 0;
    this.last = corners;

    return this.armed && this.stable >= this.stableFrames;
  }

  /** Call with the crop's sharpness once update() returns true. */
  accept(sharpness) {
    if (sharpness < this.minSharpness) return false;
    this.armed = false;
    return true;
  }
}
