export class Telemetry {
  constructor() {
    this._events = [];
    this._maxEvents = 200;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._nextFlushAtMs = 0;
  }

  frame(nowMs, dtSec) {
    const dt = Math.max(0.0001, dtSec || 0);
    this._fpsAccum += 1 / dt;
    this._fpsFrames += 1;

    if (nowMs >= this._nextFlushAtMs) {
      const fpsAvg = this._fpsFrames > 0 ? (this._fpsAccum / this._fpsFrames) : 0;
      this.track('perf.fps', { avg: Number(fpsAvg.toFixed(1)), samples: this._fpsFrames });
      this._fpsAccum = 0;
      this._fpsFrames = 0;
      this._nextFlushAtMs = nowMs + 10000;
    }
  }

  track(name, payload = {}) {
    const ev = { t: Date.now(), name, payload };
    this._events.push(ev);
    if (this._events.length > this._maxEvents) this._events.shift();

    // lightweight local telemetry sink
    if (globalThis?.console?.debug) {
      console.debug('[telemetry]', name, payload);
    }
  }

  snapshot() {
    return this._events.slice();
  }
}
