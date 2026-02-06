/**
 * Keyboard state tracker with cleanup.
 * Keeps it simple: tracks `e.code` booleans.
 */
export class KeyboardInput {
  constructor() {
    /** @type {Record<string, boolean>} */
    this.keys = {};

    /** @type {(e: KeyboardEvent) => void} */
    this._onKeyDown = (e) => {
      this.keys[e.code] = true;
    };
    /** @type {(e: KeyboardEvent) => void} */
    this._onKeyUp = (e) => {
      this.keys[e.code] = false;
    };
  }

  attach(target = window) {
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
  }

  detach(target = window) {
    target.removeEventListener('keydown', this._onKeyDown);
    target.removeEventListener('keyup', this._onKeyUp);
  }
}

