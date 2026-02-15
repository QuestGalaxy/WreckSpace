function supportsCoarsePointer() {
  if (typeof window === 'undefined') return false;
  return (
    (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0) ||
    ('ontouchstart' in window) ||
    window.matchMedia?.('(pointer: coarse)')?.matches === true
  );
}

export class MobileTouchControls {
  /**
   * @param {{ game: import('../game.js').Game, doc?: Document }} opts
   */
  constructor(opts) {
    this.game = opts.game;
    this.doc = opts.doc ?? document;
    this.root = this.doc.getElementById('mobile-controls');
    this._movePad = this.doc.getElementById('mobile-move-pad');
    this._moveKnob = this.doc.getElementById('mobile-move-knob');
    this._fireBtn = this.doc.getElementById('mobile-fire-btn');
    this._boostBtn = this.doc.getElementById('mobile-boost-btn');
    this._precisionBtn = this.doc.getElementById('mobile-precision-btn');
    this._warpBtn = this.doc.getElementById('mobile-warp-btn');
    this._speedUpBtn = this.doc.getElementById('mobile-speed-up-btn');
    this._speedDownBtn = this.doc.getElementById('mobile-speed-down-btn');

    this.enabled = false;
    this._cleanups = [];
    this._movePointerId = null;
  }

  shouldEnable() {
    return supportsCoarsePointer();
  }

  attach() {
    if (!this.root || !this.shouldEnable()) {
      if (this.root) this.root.classList.add('hidden');
      this.enabled = false;
      return false;
    }

    this.enabled = true;
    this.root.classList.remove('hidden');
    this.root.classList.remove('inactive');
    this.root.setAttribute('aria-hidden', 'false');

    this._bind(this.root, 'contextmenu', (e) => e.preventDefault());
    this._bindMovePad();
    this._bindButtons();
    return true;
  }

  detach() {
    for (const fn of this._cleanups.splice(0)) fn();
    this._clearMoveState();
    this.game?.setTouchFireHeld?.(false);
    this.game?.setTouchPrecisionHeld?.(false);
    this.game?.setVirtualKey?.('KeyZ', false);
    if (this.root) {
      this.root.classList.add('hidden');
      this.root.setAttribute('aria-hidden', 'true');
    }
    this.enabled = false;
  }

  _bind(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    this._cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  _bindMovePad() {
    const pad = this._movePad;
    if (!pad) return;

    const onDown = (e) => {
      if (this._movePointerId !== null) return;
      e.preventDefault();
      e.stopPropagation();
      this._movePointerId = e.pointerId;
      pad.setPointerCapture?.(e.pointerId);
      this._updateMoveFromPointer(e.clientX, e.clientY);
    };
    const onMove = (e) => {
      if (e.pointerId !== this._movePointerId) return;
      e.preventDefault();
      this._updateMoveFromPointer(e.clientX, e.clientY);
    };
    const onEnd = (e) => {
      if (e.pointerId !== this._movePointerId) return;
      e.preventDefault();
      this._clearMoveState();
      this._movePointerId = null;
      pad.releasePointerCapture?.(e.pointerId);
    };

    this._bind(pad, 'pointerdown', onDown);
    this._bind(pad, 'pointermove', onMove);
    this._bind(pad, 'pointerup', onEnd);
    this._bind(pad, 'pointercancel', onEnd);
    this._bind(pad, 'lostpointercapture', onEnd);
  }

  _bindHoldButton(btn, { onPress, onRelease }) {
    if (!btn) return;
    const activePointers = new Set();

    const release = (pointerId) => {
      if (!activePointers.has(pointerId)) return;
      activePointers.delete(pointerId);
      if (activePointers.size === 0) onRelease?.();
    };

    const onDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activePointers.size === 0) onPress?.();
      activePointers.add(e.pointerId);
      btn.setPointerCapture?.(e.pointerId);
    };
    const onUp = (e) => {
      e.preventDefault();
      release(e.pointerId);
    };

    this._bind(btn, 'pointerdown', onDown);
    this._bind(btn, 'pointerup', onUp);
    this._bind(btn, 'pointercancel', onUp);
    this._bind(btn, 'lostpointercapture', onUp);
  }

  _bindButtons() {
    this._bindHoldButton(this._fireBtn, {
      onPress: () => {
        this.game?.setTouchFireHeld?.(true);
        this.game?.shoot?.();
      },
      onRelease: () => this.game?.setTouchFireHeld?.(false)
    });

    this._bindHoldButton(this._boostBtn, {
      onPress: () => this.game?.setVirtualKey?.('KeyZ', true),
      onRelease: () => this.game?.setVirtualKey?.('KeyZ', false)
    });

    this._bindHoldButton(this._precisionBtn, {
      onPress: () => this.game?.setTouchPrecisionHeld?.(true),
      onRelease: () => this.game?.setTouchPrecisionHeld?.(false)
    });

    this._bind(this._warpBtn, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.game?.tryWarpToBase?.();
    });

    this._bind(this._speedUpBtn, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.game?.adjustThrottle?.(+1);
    });

    this._bind(this._speedDownBtn, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.game?.adjustThrottle?.(-1);
    });
  }

  _updateMoveFromPointer(clientX, clientY) {
    if (!this._movePad) return;
    const rect = this._movePad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const maxRadius = Math.min(rect.width, rect.height) * 0.34;
    const len = Math.hypot(dx, dy);
    if (len > maxRadius && len > 0.0001) {
      const s = maxRadius / len;
      dx *= s;
      dy *= s;
    }

    const nx = maxRadius > 0 ? dx / maxRadius : 0;
    const ny = maxRadius > 0 ? dy / maxRadius : 0;
    this._applyMoveAxes(nx, ny);

    if (this._moveKnob) {
      this._moveKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }
  }

  _applyMoveAxes(nx, ny) {
    const deadzone = 0.22;
    const left = nx < -deadzone;
    const right = nx > deadzone;
    const up = ny < -deadzone;
    const down = ny > deadzone;

    this.game?.setVirtualKey?.('KeyA', left);
    this.game?.setVirtualKey?.('KeyD', right);
    this.game?.setVirtualKey?.('KeyW', up);
    this.game?.setVirtualKey?.('KeyS', down);
  }

  _clearMoveState() {
    this.game?.setVirtualKey?.('KeyA', false);
    this.game?.setVirtualKey?.('KeyD', false);
    this.game?.setVirtualKey?.('KeyW', false);
    this.game?.setVirtualKey?.('KeyS', false);
    if (this._moveKnob) this._moveKnob.style.transform = 'translate(-50%, -50%)';
  }
}
