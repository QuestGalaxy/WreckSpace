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
    this.liveDesc = {
      ship: {
        speed: doc.getElementById('desc-ship-speed-live'),
        hull: doc.getElementById('desc-ship-hull-live'),
        cargo: doc.getElementById('desc-ship-cargo-live'),
        warp: doc.getElementById('desc-ship-warp-live')
      },
      weapon: {
        damage: doc.getElementById('desc-weapon-damage-live'),
        fireRate: doc.getElementById('desc-weapon-fireRate-live'),
        level: doc.getElementById('desc-weapon-level-live')
      },
      addon: {
        magnet: doc.getElementById('desc-addon-magnet-live'),
        shield: doc.getElementById('desc-addon-shield-live')
      }
    };

    this.addonSlotsText = doc.getElementById('addon-slots-text');
    this.addonSlotsRoot = doc.getElementById('addon-slots');

    this.crosshair = doc.getElementById('crosshair-container');
    this.lockPip = doc.getElementById('lock-pip');
    this.combatStatusEl = doc.getElementById('combat-status');
    this.hudAlertsEl = doc.getElementById('hud-alerts');
    this.mobileControlsRoot = doc.getElementById('mobile-controls');
    this.radarRoot = doc.getElementById('hud-radar');
    this.radarCanvas = doc.getElementById('hud-radar-canvas');
    this.radarLabelEl = this.radarRoot?.querySelector('.hud-radar-label') ?? null;
    this._radarCtx = this.radarCanvas?.getContext?.('2d') ?? null;
    // UI tuning: by default, keep the crosshair slightly above exact screen center so it doesn't sit on the ship.
    // Negative Y moves it upward.
    this.crosshairOffsetPx = { x: 0, y: -42 };
    this._hintMode = 'desktop';

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
    this.shieldBar?.classList.toggle('critical', shieldPercent < 25);

    const hullPercent = s.maxHull > 0 ? Math.max(0, (s.hull / s.maxHull) * 100) : 0;
    if (this.hullEl) this.hullEl.textContent = `${Math.floor(hullPercent)}%`;
    if (this.hullBar) {
      this.hullBar.style.width = `${hullPercent}%`;
      this.hullBar.style.background =
        hullPercent < 30
          ? 'linear-gradient(90deg, #ff0000, #ff4400)'
          : 'linear-gradient(90deg, #44ff44, #88ff88)';
    }
    this.hullBar?.classList.toggle('critical', hullPercent < 25);

    if (this.coinEl) this.coinEl.textContent = String(s.coin ?? 0);
    if (this.gemEl) this.gemEl.textContent = String(s.gem ?? 0);

    if (this.cargoUsedEl) this.cargoUsedEl.textContent = String(s.cargoUsed ?? 0);
    if (this.cargoMaxEl) this.cargoMaxEl.textContent = String(s.cargoMax ?? 0);
    const cargoPct = s.cargoMax > 0 ? Math.min(100, (s.cargoUsed / s.cargoMax) * 100) : 0;
    if (this.cargoBar) {
      this.cargoBar.style.width = `${cargoPct}%`;
      this.cargoBar.style.background =
        cargoPct > 90
          ? 'linear-gradient(90deg, #ff8800, #ff0000)'
          : 'linear-gradient(90deg, #0088ff, #00ffff)';
    }
    this.cargoBar?.classList.toggle('critical', cargoPct > 95);

    if (shieldPercent <= 20) this.showAlert('Shield critical', { kind: 'warning' });
    if (hullPercent <= 18) this.showAlert('Hull critical', { kind: 'error' });
    if (cargoPct >= 96) this.showAlert('Cargo almost full', { kind: 'warning' });
    if (s.warpCooldownLeftSec <= 0.05) this.showAlert('Warp ready', { kind: 'success' });
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
   *  addonSlots: (null | { id: string, name: string })[],
   *  previews?: {
   *    ship?: Record<string, string>,
   *    weapon?: Record<string, string>,
   *    addon?: Record<string, string>
   *  }
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

    const previewShip = s.previews?.ship ?? {};
    const previewWeapon = s.previews?.weapon ?? {};
    const previewAddon = s.previews?.addon ?? {};

    if (this.liveDesc.ship.speed && previewShip.speed) this.liveDesc.ship.speed.textContent = previewShip.speed;
    if (this.liveDesc.ship.hull && previewShip.hull) this.liveDesc.ship.hull.textContent = previewShip.hull;
    if (this.liveDesc.ship.cargo && previewShip.cargo) this.liveDesc.ship.cargo.textContent = previewShip.cargo;
    if (this.liveDesc.ship.warp && previewShip.warp) this.liveDesc.ship.warp.textContent = previewShip.warp;

    if (this.liveDesc.weapon.damage && previewWeapon.damage) this.liveDesc.weapon.damage.textContent = previewWeapon.damage;
    if (this.liveDesc.weapon.fireRate && previewWeapon.fireRate) this.liveDesc.weapon.fireRate.textContent = previewWeapon.fireRate;
    if (this.liveDesc.weapon.level && previewWeapon.level) this.liveDesc.weapon.level.textContent = previewWeapon.level;

    if (this.liveDesc.addon.magnet && previewAddon.magnet) this.liveDesc.addon.magnet.textContent = previewAddon.magnet;
    if (this.liveDesc.addon.shield && previewAddon.shield) this.liveDesc.addon.shield.textContent = previewAddon.shield;

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
    if (opts.kind) msgDiv.dataset.kind = String(opts.kind);

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


  /**
   * @param {'desktop'|'mobile'|'tutorial'} mode
   */
  setHintPreset(mode) {
    this._hintMode = mode;
    const map = {
      desktop: 'WASD steer | Shift precision strafe | Z boost | Space/Click fire | F warp',
      mobile: 'Left pad steer | Hold FIRE/BOOST | Tap +/- speed | WARP to deposit cargo',
      tutorial: 'Track target with crosshair | short bursts | collect loot then warp'
    };
    this.setControlsHint(map[mode] ?? map.desktop);
  }

  /**
   * @param {string} text
   * @param {{ kind?: 'info'|'warning'|'error'|'success' }} [opts]
   */
  showAlert(text, opts = {}) {
    if (!this.hudAlertsEl || !text) return;
    const key = `${opts.kind ?? 'info'}:${String(text).toLowerCase()}`;
    const now = Date.now();
    if (!this._alertCache) this._alertCache = new Map();
    const prev = this._alertCache.get(key) ?? 0;
    if (now - prev < 3000) return;
    this._alertCache.set(key, now);

    const el = this.doc.createElement('div');
    el.className = 'hud-alert';
    el.textContent = text;
    el.dataset.kind = opts.kind ?? 'info';
    this.hudAlertsEl.appendChild(el);

    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 250);
    }, 1400);
  }

  /**
   * @param {'searching'|'locked'|'outOfRange'} mode
   */
  setCombatStatus(mode) {
    if (!this.combatStatusEl) return;
    const labels = {
      searching: 'SEARCHING TARGET',
      locked: 'TARGET LOCKED',
      outOfRange: 'TARGET LOST'
    };
    this.combatStatusEl.textContent = labels[mode] ?? labels.searching;
    this.combatStatusEl.dataset.mode = mode;
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
    this.setCombatStatus(locked ? 'locked' : 'searching');
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
    this.setCombatStatus('outOfRange');
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
    if (!visible) this.setCombatStatus('searching');
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

  /**
   * @param {{
   *  rangeM: number,
   *  player: {
   *    x: number, y: number, z: number, headingRad: number,
   *    qx?: number, qy?: number, qz?: number, qw?: number
   *  },
   *  base?: { x: number, y: number, z: number } | null,
   *  planets?: { x: number, y: number, z: number, kind?: string }[],
   *  enemies?: { x: number, y: number, z: number }[]
   * } | null} snapshot
   */
  setRadarSnapshot(snapshot) {
    if (!this.radarRoot || !this.radarCanvas || !this._radarCtx) return;
    if (!snapshot?.player || !snapshot?.rangeM || snapshot.rangeM <= 0) {
      this.radarRoot.style.opacity = '0';
      return;
    }
    this.radarRoot.style.opacity = '1';

    const rangeM = Math.max(1, snapshot.rangeM);
    if (this.radarLabelEl) this.radarLabelEl.textContent = `SCAN ${Math.round(rangeM / 100) / 10}km`;

    const cw = Math.max(1, Math.floor(this.radarCanvas.clientWidth));
    const ch = Math.max(1, Math.floor(this.radarCanvas.clientHeight));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.floor(cw * dpr);
    const bh = Math.floor(ch * dpr);
    if (this.radarCanvas.width !== bw || this.radarCanvas.height !== bh) {
      this.radarCanvas.width = bw;
      this.radarCanvas.height = bh;
    }

    const ctx = this._radarCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = cw * 0.5;
    const cy = ch * 0.5;
    const radius = Math.max(8, Math.min(cw, ch) * 0.48);
    const bodyRadius = radius * 0.92;
    // Hologram sphere body.
    const fill = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.35, radius * 0.1, cx, cy, radius);
    fill.addColorStop(0, 'rgba(170,250,255,0.35)');
    fill.addColorStop(0.4, 'rgba(40,120,150,0.24)');
    fill.addColorStop(1, 'rgba(5,20,35,0.05)');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy, bodyRadius, 0, Math.PI * 2);
    ctx.fill();

    // Latitude lines.
    ctx.strokeStyle = 'rgba(120,230,255,0.16)';
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      const lat = i / 3;
      const ry = bodyRadius * lat;
      const rx = bodyRadius * Math.sqrt(Math.max(0, 1 - lat * lat));
      ctx.beginPath();
      ctx.ellipse(cx, cy + ry, rx, rx * 0.22, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Longitudes.
    ctx.strokeStyle = 'rgba(120,230,255,0.22)';
    for (let i = -2; i <= 2; i++) {
      const t = i / 5;
      const rx = bodyRadius * Math.sqrt(Math.max(0, 1 - t * t)) * 0.34;
      const x = cx + bodyRadius * t;
      ctx.beginPath();
      ctx.ellipse(x, cy, rx, bodyRadius, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Clip drawing to sphere.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, bodyRadius, 0, Math.PI * 2);
    ctx.clip();

    const qx = snapshot.player.qx ?? 0;
    const qy = snapshot.player.qy ?? 0;
    const qz = snapshot.player.qz ?? 0;
    const qw = snapshot.player.qw ?? 1;
    const qLen = Math.hypot(qx, qy, qz, qw) || 1;
    const iqx = -qx / qLen;
    const iqy = -qy / qLen;
    const iqz = -qz / qLen;
    const iqw = qw / qLen;

    const rotateByInverseQuat = (vx, vy, vz) => {
      // v' = q^-1 * v * q
      const tx = 2 * (iqy * vz - iqz * vy);
      const ty = 2 * (iqz * vx - iqx * vz);
      const tz = 2 * (iqx * vy - iqy * vx);
      return {
        x: vx + iqw * tx + (iqy * tz - iqz * ty),
        y: vy + iqw * ty + (iqz * tx - iqx * tz),
        z: vz + iqw * tz + (iqx * ty - iqy * tx)
      };
    };

    /** @type {{ sx:number, sy:number, depth:number, size:number, color:string, kind:'dot'|'diamond' }[]} */
    const blips = [];
    const pushTrack = (x, y, z, color, size, kind = 'dot') => {
      const dx = x - snapshot.player.x;
      const dy = y - snapshot.player.y;
      const dz = z - snapshot.player.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > rangeM) return;

      const local = rotateByInverseQuat(dx, dy, dz);
      const invRange = 1 / rangeM;
      let nx = local.x * invRange;
      let ny = local.y * invRange;
      let nz = local.z * invRange;
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen > 1e-6) {
        const cl = Math.min(1, nLen);
        nx = (nx / nLen) * cl;
        ny = (ny / nLen) * cl;
        nz = (nz / nLen) * cl;
      }

      blips.push({
        sx: cx + nx * bodyRadius,
        sy: cy - ny * bodyRadius,
        depth: nz,
        size,
        color,
        kind
      });
    };

    if (snapshot.base) {
      pushTrack(snapshot.base.x, snapshot.base.y, snapshot.base.z, 'rgba(120,255,250,0.98)', 4.5, 'diamond');
    }
    for (const p of snapshot.planets ?? []) {
      const size = p.kind === 'planet_large' ? 3.4 : p.kind === 'planet_medium' ? 2.8 : 2.3;
      pushTrack(p.x, p.y, p.z, 'rgba(100,180,255,0.92)', size, 'dot');
    }
    for (const e of snapshot.enemies ?? []) {
      pushTrack(e.x, e.y, e.z, 'rgba(255,110,110,0.98)', 2.2, 'dot');
    }

    // Draw far hemisphere first, near hemisphere last.
    blips.sort((a, b) => a.depth - b.depth);
    for (const b of blips) {
      const vis = Math.max(0.18, 0.30 + ((b.depth + 1) * 0.5) * 0.9);
      const glow = Math.max(0.08, b.depth > 0 ? 0.42 : 0.16);
      const isBackHemisphere = b.depth < 0;
      ctx.globalAlpha = vis;
      if (!isBackHemisphere) {
        if (b.kind === 'diamond') {
          ctx.fillStyle = b.color;
          ctx.save();
          ctx.translate(b.sx, b.sy);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-b.size, -b.size, b.size * 2, b.size * 2);
          ctx.restore();
        } else {
          ctx.fillStyle = b.color;
          ctx.beginPath();
          ctx.arc(b.sx, b.sy, b.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = isBackHemisphere ? Math.max(0.18, glow * 1.45) : glow;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.sx, b.sy, b.size * (isBackHemisphere ? 2.8 : 2.1), 0, Math.PI * 2);
      ctx.fill();
      if (isBackHemisphere) {
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(b.sx, b.sy, b.size * 1.55, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Subtle scan sweep.
    const sweep = ((Date.now() * 0.00035) % 1) * Math.PI * 2;
    ctx.strokeStyle = 'rgba(160,255,255,0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, bodyRadius * 0.92, sweep - 0.20, sweep + 0.20);
    ctx.stroke();
    ctx.restore();

    // Player indicator at center (live heading).
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(snapshot.player.headingRad ?? 0);
    ctx.fillStyle = 'rgba(220,255,255,0.96)';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(4.8, 6);
    ctx.lineTo(0, 3.4);
    ctx.lineTo(-4.8, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(170,250,255,0.52)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(cx, cy, bodyRadius, 0, Math.PI * 2);
    ctx.stroke();
  }
}
