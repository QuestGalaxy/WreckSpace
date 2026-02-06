/**
 * HUD DOM wrapper. Keeps DOM queries in one place.
 * Game code should call methods here instead of touching the DOM directly.
 */
export class HudController {
  constructor(doc = document) {
    this.doc = doc;

    this.energyEl = doc.getElementById('energy-val');
    this.energyBar = doc.getElementById('energy-bar');
    this.storageEl = doc.getElementById('storage-val');
    this.storageBar = doc.getElementById('storage-bar');
    this.maxStorageEl = doc.getElementById('max-storage-val');
    this.lootEl = doc.getElementById('loot-val');
    this.messagesEl = doc.getElementById('messages');
    this.baseMenu = doc.getElementById('base-menu');
    this.resumeBtn = doc.getElementById('resume-btn');

    this.crosshair = doc.getElementById('crosshair-container');

    this.baseMarker = doc.getElementById('base-marker');
    this.baseMarkerDist = this.baseMarker?.querySelector('.marker-dist') ?? null;
    this.baseMarkerArrow = this.baseMarker?.querySelector('.marker-arrow') ?? null;

    /** @type {null | (() => void)} */
    this._resumeHandler = null;
    if (this.resumeBtn) {
      this.resumeBtn.addEventListener('click', () => {
        if (this._resumeHandler) this._resumeHandler();
      });
    }
  }

  setMaxStorage(maxStorage) {
    if (this.maxStorageEl) this.maxStorageEl.textContent = String(maxStorage);
  }

  /**
   * @param {{ energy: number, maxEnergy: number, storage: number, maxStorage: number, loot: number }} s
   */
  setStats(s) {
    const energyPercent = Math.max(0, (s.energy / s.maxEnergy) * 100);
    if (this.energyEl) this.energyEl.textContent = `${Math.floor(energyPercent)}%`;
    if (this.energyBar) {
      this.energyBar.style.width = `${energyPercent}%`;
      this.energyBar.style.background =
        energyPercent < 30
          ? 'linear-gradient(90deg, #ff0000, #ff4400)'
          : 'linear-gradient(90deg, #0088ff, #00ffff)';
    }

    if (this.storageEl) this.storageEl.textContent = String(s.storage);
    if (this.storageBar) {
      const storagePercent = Math.min(100, (s.storage / s.maxStorage) * 100);
      this.storageBar.style.width = `${storagePercent}%`;
      this.storageBar.style.background =
        storagePercent > 90
          ? 'linear-gradient(90deg, #ff8800, #ff0000)'
          : 'linear-gradient(90deg, #0088ff, #00ffff)';
    }

    if (this.lootEl) this.lootEl.textContent = String(s.loot);
  }

  /**
   * @param {string} text
   * @param {{ isError?: boolean }} [opts]
   */
  showMessage(text, opts = {}) {
    if (!this.messagesEl) return;

    const msgDiv = this.doc.createElement('div');
    msgDiv.className = 'message';
    msgDiv.textContent = text;
    if (opts.isError) msgDiv.dataset.kind = 'error';

    this.messagesEl.innerHTML = '';
    this.messagesEl.appendChild(msgDiv);

    setTimeout(() => {
      if (!this.messagesEl.contains(msgDiv)) return;
      msgDiv.style.opacity = '0';
      setTimeout(() => {
        if (this.messagesEl.contains(msgDiv)) this.messagesEl.removeChild(msgDiv);
      }, 500);
    }, 2500);
  }

  setBaseMenuVisible(visible) {
    if (!this.baseMenu) return;
    if (visible) this.baseMenu.classList.remove('hidden');
    else this.baseMenu.classList.add('hidden');
  }

  /**
   * @param {() => void} handler
   */
  onResume(handler) {
    this._resumeHandler = handler;
  }

  crosshairSetLocked(locked) {
    if (!this.crosshair) return;
    if (locked) this.crosshair.classList.add('locked');
    else this.crosshair.classList.remove('locked');
  }

  crosshairSetScreenPos(x, y) {
    if (!this.crosshair) return;
    this.crosshair.style.left = `${x}px`;
    this.crosshair.style.top = `${y}px`;
  }

  crosshairResetToCenter() {
    if (!this.crosshair) return;
    this.crosshair.style.left = '50%';
    this.crosshair.style.top = '50%';
    this.crosshair.style.transform = 'translate(-50%, -50%)';
  }

  crosshairSetLockedTransform() {
    if (!this.crosshair) return;
    this.crosshair.style.transform = 'translate(-50%, -50%) rotate(45deg) scale(0.8)';
  }

  crosshairPulseFiring() {
    if (!this.crosshair) return;
    this.crosshair.classList.add('firing');
    setTimeout(() => this.crosshair?.classList.remove('firing'), 100);
  }

  crosshairPulseHit() {
    if (!this.crosshair) return;
    this.crosshair.classList.remove('hit');
    // Trigger reflow to restart CSS animation.
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add('hit');
    setTimeout(() => this.crosshair?.classList.remove('hit'), 150);
  }

  /**
   * @param {{ x: number, y: number, angleDeg: number, distM: number, offScreen: boolean }} s
   */
  setBaseMarker(s) {
    if (!this.baseMarker) return;
    if (this.baseMarkerDist) this.baseMarkerDist.textContent = `${Math.round(s.distM)}m`;

    if (s.offScreen) this.baseMarker.classList.add('off-screen');
    else this.baseMarker.classList.remove('off-screen');

    if (this.baseMarkerArrow) {
      this.baseMarkerArrow.style.transform = s.offScreen ? `rotate(${s.angleDeg}deg)` : 'none';
    }

    this.baseMarker.style.left = `${s.x}px`;
    this.baseMarker.style.top = `${s.y}px`;
    this.baseMarker.style.opacity = '1';
  }
}

