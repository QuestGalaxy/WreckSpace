/**
 * HUD DOM wrapper. Keeps DOM queries in one place.
 * Game code should call methods here instead of touching the DOM directly.
 */
export class HudController {
  constructor(doc = document) {
    this.doc = doc;

    // HUD (in-game)
    this.shieldEl = doc.getElementById('shield-val');
    this.shieldBar = doc.getElementById('shield-bar');
    this.hullEl = doc.getElementById('hull-val');
    this.hullBar = doc.getElementById('hull-bar');

    this.coinEl = doc.getElementById('coin-val');
    this.gemEl = doc.getElementById('gem-val');

    this.cargoUsedEl = doc.getElementById('cargo-used-val');
    this.cargoBar = doc.getElementById('cargo-bar');
    this.cargoMaxEl = doc.getElementById('cargo-max-val');

    this.messagesEl = doc.getElementById('messages');
    this.controlsHintEl = doc.getElementById('controls-hint');
    this.baseMenu = doc.getElementById('base-menu');
    this.resumeBtn = doc.getElementById('resume-btn');

    // Base menu
    this.baseCoinEl = doc.getElementById('base-coin');
    this.baseGemEl = doc.getElementById('base-gem');
    this.baseWeaponLevelEl = doc.getElementById('base-weapon-level');

    this.costShip = {
      speed: doc.getElementById('cost-ship-speed'),
      hull: doc.getElementById('cost-ship-hull'),
      cargo: doc.getElementById('cost-ship-cargo'),
      warp: doc.getElementById('cost-ship-warp')
    };
    this.costWeapon = {
      damage: doc.getElementById('cost-weapon-damage'),
      fireRate: doc.getElementById('cost-weapon-fireRate'),
      level: doc.getElementById('cost-weapon-level')
    };
    this.costAddon = {
      magnet: doc.getElementById('cost-addon-magnet'),
      shield: doc.getElementById('cost-addon-shield')
    };
    this.addonSlotsText = doc.getElementById('addon-slots-text');
    this.addonSlotsRoot = doc.getElementById('addon-slots');

    this.crosshair = doc.getElementById('crosshair-container');
    this.lockPip = doc.getElementById('lock-pip');
    this.mobileControlsRoot = doc.getElementById('mobile-controls');
    // UI tuning: by default, keep the crosshair slightly above exact screen center so it doesn't sit on the ship.
    // Negative Y moves it upward.
    this.crosshairOffsetPx = { x: 0, y: -42 };

    this.baseMarker = doc.getElementById('base-marker');
    this.baseMarkerDist = this.baseMarker?.querySelector('.marker-dist') ?? null;
    this.baseMarkerArrow = this.baseMarker?.querySelector('.marker-arrow') ?? null;

    /** @type {null | (() => void)} */
    this._resumeHandler = null;
    /** @type {null | ((statId: string) => void)} */
    this._upgradeShipHandler = null;
    /** @type {null | ((attrId: string) => void)} */
    this._upgradeWeaponHandler = null;
    /** @type {null | (() => void)} */
    this._craftWeaponLevelHandler = null;
    /** @type {null | ((addonId: string) => void)} */
    this._buyAddonHandler = null;

    if (this.resumeBtn) {
      this.resumeBtn.addEventListener('click', () => {
        if (this._resumeHandler) this._resumeHandler();
      });
    }

    // Delegate clicks inside base menu so Game owns logic.
    if (this.baseMenu) {
      this.baseMenu.addEventListener('click', (e) => {
        const t = /** @type {any} */ (e.target);
        const btn = t?.closest?.('button');
        if (!btn) return;

        const shipStat = btn.getAttribute('data-upgrade-ship');
        if (shipStat && this._upgradeShipHandler) return void this._upgradeShipHandler(shipStat);

        const wAttr = btn.getAttribute('data-upgrade-weapon');
        if (wAttr && this._upgradeWeaponHandler) return void this._upgradeWeaponHandler(wAttr);

        const craft = btn.getAttribute('data-craft-weapon-level');
        if (craft && this._craftWeaponLevelHandler) return void this._craftWeaponLevelHandler();

        const addon = btn.getAttribute('data-buy-addon');
        if (addon && this._buyAddonHandler) return void this._buyAddonHandler(addon);
      });
    }
  }

  /**
   * HUD-only stats (in-flight).
   * @param {{
   *  hull: number, maxHull: number,
   *  shield: number, maxShield: number,
   *  cargoUsed: number, cargoMax: number,
   *  coin: number, gem: number,
   *  warpCooldownLeftSec: number
   * }} s
   */
  setStats(s) {
    const shieldPercent = s.maxShield > 0 ? Math.max(0, (s.shield / s.maxShield) * 100) : 0;
    if (this.shieldEl) this.shieldEl.textContent = `${Math.floor(shieldPercent)}%`;
    if (this.shieldBar) {
      this.shieldBar.style.width = `${shieldPercent}%`;
      this.shieldBar.style.background =
        shieldPercent < 30
          ? 'linear-gradient(90deg, #ff0000, #ff4400)'
          : 'linear-gradient(90deg, #0088ff, #00ffff)';
    }

    const hullPercent = s.maxHull > 0 ? Math.max(0, (s.hull / s.maxHull) * 100) : 0;
    if (this.hullEl) this.hullEl.textContent = `${Math.floor(hullPercent)}%`;
    if (this.hullBar) {
      this.hullBar.style.width = `${hullPercent}%`;
      this.hullBar.style.background =
        hullPercent < 30
          ? 'linear-gradient(90deg, #ff0000, #ff4400)'
          : 'linear-gradient(90deg, #44ff44, #88ff88)';
    }

    if (this.coinEl) this.coinEl.textContent = String(s.coin ?? 0);
    if (this.gemEl) this.gemEl.textContent = String(s.gem ?? 0);

    if (this.cargoUsedEl) this.cargoUsedEl.textContent = String(s.cargoUsed ?? 0);
    if (this.cargoMaxEl) this.cargoMaxEl.textContent = String(s.cargoMax ?? 0);
    if (this.cargoBar) {
      const p = s.cargoMax > 0 ? Math.min(100, (s.cargoUsed / s.cargoMax) * 100) : 0;
      this.cargoBar.style.width = `${p}%`;
      this.cargoBar.style.background =
        p > 90
          ? 'linear-gradient(90deg, #ff8800, #ff0000)'
          : 'linear-gradient(90deg, #0088ff, #00ffff)';
    }

    // Keep warp cooldown as a subtle HUD message (no dedicated widget yet).
    if (s.warpCooldownLeftSec > 0.01) {
      // Do nothing; Game is expected to message on attempted warp.
    }
  }

  /**
   * Base menu state (wallet + costs + slots).
   * @param {{
   *  coin: number, gem: number,
   *  weaponLevelTier: number,
   *  costs: {
   *    ship: Record<string, number|null>,
   *    weapon: Record<string, number|null>,
   *    weaponLevelGem: number|null,
   *    addon: Record<string, number>
   *  },
   *  disabled: {
   *    ship: Record<string, boolean>,
   *    weapon: Record<string, boolean>,
   *    craftWeaponLevel: boolean,
   *    addon: Record<string, boolean>
   *  },
   *  addonSlots: (null | { id: string, name: string })[]
   * }} s
   */
  setBaseMenuState(s) {
    if (this.baseCoinEl) this.baseCoinEl.textContent = String(s.coin ?? 0);
    if (this.baseGemEl) this.baseGemEl.textContent = String(s.gem ?? 0);
    if (this.baseWeaponLevelEl) this.baseWeaponLevelEl.textContent = String(s.weaponLevelTier ?? 1);

    const setCost = (el, v, suffix) => {
      if (!el) return;
      if (v == null) el.textContent = 'MAX';
      else el.textContent = `${v}${suffix ?? ''}`;
    };

    setCost(this.costShip.speed, s.costs?.ship?.speed ?? null, 'c');
    setCost(this.costShip.hull, s.costs?.ship?.hull ?? null, 'c');
    setCost(this.costShip.cargo, s.costs?.ship?.cargo ?? null, 'c');
    setCost(this.costShip.warp, s.costs?.ship?.warp ?? null, 'c');

    setCost(this.costWeapon.damage, s.costs?.weapon?.damage ?? null, 'c');
    setCost(this.costWeapon.fireRate, s.costs?.weapon?.fireRate ?? null, 'c');
    setCost(this.costWeapon.level, s.costs?.weaponLevelGem ?? null, 'g');

    if (this.costAddon.magnet) this.costAddon.magnet.textContent = `${s.costs?.addon?.magnet ?? 0}g`;
    if (this.costAddon.shield) this.costAddon.shield.textContent = `${s.costs?.addon?.shield ?? 0}g`;

    // Disable buttons by querying via data attributes.
    const root = this.baseMenu;
    if (root) {
      for (const [k, v] of Object.entries(s.disabled?.ship ?? {})) {
        const btn = root.querySelector(`button[data-upgrade-ship="${k}"]`);
        if (btn) btn.toggleAttribute('disabled', !!v);
      }
      for (const [k, v] of Object.entries(s.disabled?.weapon ?? {})) {
        const btn = root.querySelector(`button[data-upgrade-weapon="${k}"]`);
        if (btn) btn.toggleAttribute('disabled', !!v);
      }
      const craftBtn = root.querySelector('button[data-craft-weapon-level]');
      if (craftBtn) craftBtn.toggleAttribute('disabled', !!s.disabled?.craftWeaponLevel);
      for (const [k, v] of Object.entries(s.disabled?.addon ?? {})) {
        const btn = root.querySelector(`button[data-buy-addon="${k}"]`);
        if (btn) btn.toggleAttribute('disabled', !!v);
      }
    }

    // Addon slots
    const filled = (s.addonSlots ?? []).filter(Boolean).length;
    if (this.addonSlotsText) this.addonSlotsText.textContent = `${filled}/${(s.addonSlots ?? []).length || 3}`;
    if (this.addonSlotsRoot) {
      this.addonSlotsRoot.innerHTML = '';
      for (let i = 0; i < (s.addonSlots ?? []).length; i++) {
        const slot = s.addonSlots[i];
        const div = this.doc.createElement('div');
        div.className = `addon-slot ${slot ? '' : 'empty'}`;
        const left = this.doc.createElement('div');
        left.textContent = slot ? slot.name : 'Empty';
        const right = this.doc.createElement('div');
        right.textContent = slot ? slot.id.toUpperCase() : '-';
        div.appendChild(left);
        div.appendChild(right);
        this.addonSlotsRoot.appendChild(div);
      }
    }
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
    if (this.mobileControlsRoot) this.mobileControlsRoot.classList.toggle('inactive', !!visible);
  }

  /**
   * @param {string} text
   */
  setControlsHint(text) {
    if (!this.controlsHintEl) return;
    this.controlsHintEl.textContent = text;
  }

  setBaseMarkerVisible(visible) {
    if (!this.baseMarker) return;
    this.baseMarker.style.opacity = visible ? '1' : '0';
    if (!visible) this.baseMarker.classList.remove('off-screen');
  }

  /**
   * @param {() => void} handler
   */
  onResume(handler) {
    this._resumeHandler = handler;
  }

  /**
   * @param {(statId: string) => void} handler
   */
  onUpgradeShipStat(handler) {
    this._upgradeShipHandler = handler;
  }

  /**
   * @param {(attrId: string) => void} handler
   */
  onUpgradeWeaponAttr(handler) {
    this._upgradeWeaponHandler = handler;
  }

  /**
   * @param {() => void} handler
   */
  onCraftWeaponLevel(handler) {
    this._craftWeaponLevelHandler = handler;
  }

  /**
   * @param {(addonId: string) => void} handler
   */
  onBuyAddon(handler) {
    this._buyAddonHandler = handler;
  }

  crosshairSetLocked(locked) {
    if (!this.crosshair) return;
    if (locked) this.crosshair.classList.add('locked');
    else this.crosshair.classList.remove('locked');
  }

  crosshairSetScreenPos(x, y) {
    if (!this.crosshair) return;
    const ox = this.crosshairOffsetPx?.x ?? 0;
    const oy = this.crosshairOffsetPx?.y ?? 0;
    this.crosshair.style.left = `${x + ox}px`;
    this.crosshair.style.top = `${y + oy}px`;
  }

  crosshairResetToCenter() {
    if (!this.crosshair) return;
    const ox = this.crosshairOffsetPx?.x ?? 0;
    const oy = this.crosshairOffsetPx?.y ?? 0;
    this.crosshair.style.left = ox ? `calc(50% + ${ox}px)` : '50%';
    this.crosshair.style.top = oy ? `calc(50% + ${oy}px)` : '50%';
    this.crosshair.style.transform = 'translate(-50%, -50%)';
  }

  // Used when the locked target disappears (e.g. destroyed). We want an immediate snap,
  // not the CSS transition that can look like the crosshair is "stuck" for a moment.
  crosshairUnlockAndSnapToCenter() {
    if (!this.crosshair) return;

    const prevTransition = this.crosshair.style.transition;
    this.crosshair.style.transition = 'none';
    this.crosshair.classList.remove('locked');
    const ox = this.crosshairOffsetPx?.x ?? 0;
    const oy = this.crosshairOffsetPx?.y ?? 0;
    this.crosshair.style.left = ox ? `calc(50% + ${ox}px)` : '50%';
    this.crosshair.style.top = oy ? `calc(50% + ${oy}px)` : '50%';
    this.crosshair.style.transform = 'translate(-50%, -50%)';

    // Force style flush so the snap happens before we restore transitions.
    void this.crosshair.offsetWidth;
    this.crosshair.style.transition = prevTransition;
  }

  crosshairSetLockedTransform() {
    if (!this.crosshair) return;
    // Keep lock state readable but subtle (less "heavy" rotation/scale).
    this.crosshair.style.transform = 'translate(-50%, -50%) rotate(12deg) scale(0.92)';
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

  lockPipSetVisible(visible) {
    if (!this.lockPip) return;
    this.lockPip.classList.toggle('visible', !!visible);
  }

  lockPipSetScreenPos(x, y) {
    if (!this.lockPip) return;
    this.lockPip.style.left = `${x}px`;
    this.lockPip.style.top = `${y}px`;
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

  /**
   * Optional runtime tuning.
   * @param {number} x
   * @param {number} y
   */
  setCrosshairOffsetPx(x, y) {
    this.crosshairOffsetPx = { x: Number(x) || 0, y: Number(y) || 0 };
    // Apply immediately if we're currently centered.
    // (If locked, CombatSystem will keep pushing px positions anyway.)
    this.crosshairResetToCenter();
  }
}
