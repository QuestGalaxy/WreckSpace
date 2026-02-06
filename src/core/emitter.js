/**
 * Tiny event emitter (no deps).
 * Intentionally minimal: good enough for decoupling UI/sim without introducing a framework.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * @template T
   * @param {string} event
   * @param {(payload: T) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(event, fn) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  /**
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.listeners.delete(event);
  }

  /**
   * @template T
   * @param {string} event
   * @param {T} payload
   */
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy to allow listeners to unsubscribe during emit safely.
    [...set].forEach((fn) => fn(payload));
  }
}

