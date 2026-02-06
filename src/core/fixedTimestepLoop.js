/**
 * Fixed timestep runner to decouple simulation from rendering FPS.
 * The simulation step is called at a constant `stepHz` when possible.
 */
export class FixedTimestepLoop {
  /**
   * @param {{ stepHz?: number, maxSubSteps?: number }} [opts]
   */
  constructor(opts = {}) {
    this.stepHz = opts.stepHz ?? 60;
    this.maxSubSteps = opts.maxSubSteps ?? 5;

    this._fixedDtSec = 1 / this.stepHz;
    this._accumSec = 0;
    /** @type {number|null} */
    this._lastFrameMs = null;
  }

  get fixedDtSec() {
    return this._fixedDtSec;
  }

  /**
   * @param {number} nowMs
   * @param {(dtSec: number) => void} stepFn
   * @returns {{ steps: number, alpha: number }}
   */
  advance(nowMs, stepFn) {
    if (this._lastFrameMs == null) {
      this._lastFrameMs = nowMs;
      return { steps: 0, alpha: 0 };
    }

    // Avoid huge catch-up after tab switch.
    const frameDtSec = Math.min(0.25, (nowMs - this._lastFrameMs) / 1000);
    this._lastFrameMs = nowMs;
    this._accumSec += frameDtSec;

    let steps = 0;
    while (this._accumSec >= this._fixedDtSec && steps < this.maxSubSteps) {
      stepFn(this._fixedDtSec);
      this._accumSec -= this._fixedDtSec;
      steps++;
    }

    return { steps, alpha: this._accumSec / this._fixedDtSec };
  }
}

