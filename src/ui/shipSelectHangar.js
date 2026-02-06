import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createVoxelTextures } from '../render/voxelTextures.js';
import { createVoxelShipModel } from '../render/voxelShipFactory.js';

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

export class ShipSelectHangar {
  /**
   * @param {{
   *  canvas: HTMLCanvasElement,
   *  ships: any[],
   *  onSelect: (ship: any) => void
   * }} opts
   */
  constructor(opts) {
    this.canvas = opts.canvas;
    this.ships = opts.ships ?? [];
    this.onSelect = opts.onSelect;

    this._raf = 0;
    this._tPrev = 0;

    this._index = 0;
    this._scroll = 0;

    this._pointerDown = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragDeltaX = 0;
    this._lastDragMs = 0;

    // DOM bindings
    this.el = {
      root: document.getElementById('selection-screen'),
      prev: document.getElementById('ship-prev'),
      next: document.getElementById('ship-next'),
      select: document.getElementById('ship-select'),
      name: document.getElementById('ship-name'),
      klass: document.getElementById('ship-class'),
      desc: document.getElementById('ship-desc'),
      power: document.getElementById('ship-power'),
      speed: document.getElementById('ship-speed'),
      storage: document.getElementById('ship-storage'),
      powerBar: document.getElementById('ship-power-bar'),
      speedBar: document.getElementById('ship-speed-bar'),
      storageBar: document.getElementById('ship-storage-bar')
    };

    // Visual constants tuned to match the voxel game.
    this.voxelSize = 5.0;
    this.worldScale = this.voxelSize / 2.0;
    this.theme = {
      ship: { dark: 0x1b1f2a, accent: 0xffaa22, glass: 0x0b1222, thruster: 0x66ccff }
    };
  }

  init() {
    this._initThree();
    this._initDom();
    this._buildHangar();
    this._buildShips();
    this.setIndex(0, { immediate: true });
    this._onResize();
    window.addEventListener('resize', this._onResize);
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    if (this.el.prev) this.el.prev.removeEventListener('click', this._onPrev);
    if (this.el.next) this.el.next.removeEventListener('click', this._onNext);
    if (this.el.select) this.el.select.removeEventListener('click', this._onSelectBtn);
    if (this.el.root) {
      this.el.root.removeEventListener('pointerdown', this._onPointerDown);
      this.el.root.removeEventListener('pointermove', this._onPointerMove);
      this.el.root.removeEventListener('pointerup', this._onPointerUp);
      this.el.root.removeEventListener('pointercancel', this._onPointerUp);
    }
    window.removeEventListener('keydown', this._onKeyDown);

    if (this.composer?.dispose) this.composer.dispose();
    if (this.renderer) this.renderer.dispose();
  }

  setIndex(idx, { immediate = false } = {}) {
    if (this.ships.length === 0) return;
    const next = clamp(idx, 0, this.ships.length - 1);
    this._index = next;
    if (immediate) this._scroll = next;
    this._updateInfo();
  }

  _initDom() {
    this._onPrev = () => this.setIndex(this._index - 1);
    this._onNext = () => this.setIndex(this._index + 1);
    this._onSelectBtn = () => this.onSelect?.(this.ships[this._index]);

    if (this.el.prev) this.el.prev.addEventListener('click', this._onPrev);
    if (this.el.next) this.el.next.addEventListener('click', this._onNext);
    if (this.el.select) this.el.select.addEventListener('click', this._onSelectBtn);

    this._onKeyDown = (e) => {
      if (e.code === 'ArrowLeft') this.setIndex(this._index - 1);
      else if (e.code === 'ArrowRight') this.setIndex(this._index + 1);
      else if (e.code === 'Enter') this.onSelect?.(this.ships[this._index]);
    };
    window.addEventListener('keydown', this._onKeyDown);

    // Swipe / drag
    this._onPointerDown = (e) => {
      // Don't hijack clicks on UI controls.
      const target = /** @type {any} */ (e.target);
      if (target && typeof target.closest === 'function' && target.closest('button')) return;

      this._pointerDown = true;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._dragDeltaX = 0;
      this._lastDragMs = performance.now();
      // Only capture for drags. Capturing unconditionally would break button clicks.
      this.el.root?.setPointerCapture?.(e.pointerId);
    };
    this._onPointerMove = (e) => {
      if (!this._pointerDown) return;
      this._dragDeltaX = e.clientX - this._dragStartX;
      this._lastDragMs = performance.now();
    };
    this._onPointerUp = () => {
      if (!this._pointerDown) return;
      this._pointerDown = false;

      const dx = this._dragDeltaX;
      const dy = 0; // reserved
      void dy;

      // Only treat it as a swipe if it's intentional and mostly horizontal.
      if (Math.abs(dx) > 60) {
        if (dx > 0) this.setIndex(this._index - 1);
        else this.setIndex(this._index + 1);
      }
      this._dragDeltaX = 0;
    };

    if (this.el.root) {
      this.el.root.addEventListener('pointerdown', this._onPointerDown);
      this.el.root.addEventListener('pointermove', this._onPointerMove);
      this.el.root.addEventListener('pointerup', this._onPointerUp);
      this.el.root.addEventListener('pointercancel', this._onPointerUp);
    }
  }

  _initThree() {
    this.scene = new THREE.Scene();
    // Match in-game: lifted blacks so the hangar isn't murky.
    this.scene.background = new THREE.Color(0x15162c);
    this.scene.fog = new THREE.FogExp2(0x0a0b1e, 0.00025 / this.worldScale);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000 * this.worldScale);
    // Requested: a bit farther and higher so the ship reads better.
    this.camera.position.set(18 * this.worldScale, 66 * this.worldScale, 182 * this.worldScale);
    this.camera.lookAt(0, 22 * this.worldScale, 0);

    // Hangar should be crystal clear (no CRT pixelation).
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Avoid filmic/realistic grading; CRT pass handles style.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Keep bloom very subtle to avoid haze.
    this._bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.18, 0.08, 0.55);
    this.composer.addPass(this._bloom);

    this.textures = createVoxelTextures();

    // Bind resize handler.
    this._onResize = () => {
      if (!this.camera || !this.renderer) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
    };
  }

  _voxLit({ color, map = null, emissive = 0x000000, emissiveIntensity = 0 } = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      map: map ?? null,
      emissive,
      emissiveIntensity,
      metalness: 0.0,
      roughness: 1.0,
      flatShading: true,
      vertexColors: true
    });
  }

  _buildHangar() {
    const ws = this.worldScale;

    // Lights
    // Match the in-game vibe: strong ambient + one key directional + small fill/rim.
    this.scene.add(new THREE.AmbientLight(0x8b8bb0, 1.35));

    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(140 * ws, 220 * ws, 180 * ws);
    key.target.position.set(0, 0, 0);
    this.scene.add(key);
    this.scene.add(key.target);
    this._key = key;

    const fill = new THREE.DirectionalLight(0xffe8cc, 0.55);
    fill.position.set(120 * ws, 110 * ws, 260 * ws);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0x66ccff, 0.75);
    rim.position.set(-200 * ws, 120 * ws, -240 * ws);
    this.scene.add(rim);

    // Floor
    const floorTex = this.textures.panels;
    floorTex.repeat.set(24, 24);
    const floorMat = this._voxLit({ color: 0xb3b8c6, map: floorTex, emissive: 0x1a1c28, emissiveIntensity: 0.10 });
    floorMat.roughness = 0.95;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1800 * ws, 1800 * ws, 1, 1), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    this.scene.add(floor);

    // Back wall
    const wallTex = this.textures.panelsDark;
    wallTex.repeat.set(14, 6);
    const wallMat = this._voxLit({ color: 0x2b3146, map: wallTex, emissive: 0x123060, emissiveIntensity: 0.14 });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(1400 * ws, 560 * ws), wallMat);
    wall.position.set(0, 240 * ws, -520 * ws);
    this.scene.add(wall);

    // Side pillars for depth
    const pillarMat = this._voxLit({ color: 0x37405b, map: wallTex, emissive: 0x0b0d1a, emissiveIntensity: 0.08 });
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(70 * ws, 520 * ws, 70 * ws), pillarMat);
        p.position.set(sx * 620 * ws, 260 * ws, -320 * ws + i * 160 * ws);
        this.scene.add(p);
      }
    }

    // Emissive runway strips
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending });
    for (const sx of [-1, 1]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(20 * ws, 1200 * ws), stripMat);
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(sx * 220 * ws, 0.15 * ws, -120 * ws);
      this.scene.add(strip);
    }

    // Floating dust motes (gives depth even when ships are still)
    const dustGeo = new THREE.BufferGeometry();
    const count = 900;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      arr[ix] = (Math.random() - 0.5) * 900 * ws;
      arr[ix + 1] = Math.random() * 520 * ws;
      arr[ix + 2] = (Math.random() - 0.5) * 900 * ws;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: 0xbfe6ff, size: 2.0, transparent: true, opacity: 0.25, sizeAttenuation: true })
    );
    this.scene.add(dust);
    this._dust = dust;
  }

  _buildShips() {
    this.shipEntries = [];
    for (const shipData of this.ships) {
      const { group, bounds } = createVoxelShipModel({
        shipData,
        voxelSize: this.voxelSize,
        textures: this.textures,
        theme: this.theme,
        voxLit: (o) => this._voxLit(o)
      });

      // Base transform in hangar
      group.position.y += 12.0 * this.voxelSize;
      group.rotation.y = Math.PI;

      this.scene.add(group);
      this.shipEntries.push({ shipData, group, size: bounds.size });
    }

    // Spacing based on widest ship.
    const maxW = Math.max(1, ...this.shipEntries.map((e) => e.size.x));
    this._spacing = maxW * 1.25 + 26 * this.voxelSize;
  }

  _updateInfo() {
    const ship = this.ships[this._index];
    if (!ship) return;

    // Flavor class
    let shipClass = 'Standard Class';
    if (ship.id === 'scout') shipClass = 'Reconnaissance Class';
    else if (ship.id === 'interceptor') shipClass = 'Assault Class';
    else if (ship.id === 'hauler') shipClass = 'Industrial Class';

    if (this.el.name) this.el.name.textContent = ship.name;
    if (this.el.klass) this.el.klass.textContent = shipClass;
    if (this.el.desc) this.el.desc.textContent = ship.description ?? '';

    if (this.el.power) this.el.power.textContent = String(ship.weaponPower ?? 0);
    if (this.el.speed) this.el.speed.textContent = String(ship.speed ?? 0);
    if (this.el.storage) this.el.storage.textContent = String(ship.storage ?? 0);

    const powerPct = ((ship.weaponPower ?? 0) / 25) * 100;
    const speedPct = ((ship.speed ?? 0) / 1.5) * 100;
    const storagePct = ((ship.storage ?? 0) / 120) * 100;

    // Animate bars
    const setBar = (el, pct) => {
      if (!el) return;
      el.style.width = `${clamp(pct, 0, 100)}%`;
    };
    setBar(this.el.powerBar, powerPct);
    setBar(this.el.speedBar, speedPct);
    setBar(this.el.storageBar, storagePct);
  }

  _tick(nowMs) {
    this._raf = requestAnimationFrame((t) => this._tick(t));
    const dt = Math.min(0.05, (nowMs - (this._tPrev || nowMs)) / 1000);
    this._tPrev = nowMs;
    const t = nowMs / 1000;

    // Smooth scroll toward selected index, but allow live dragging.
    const scrollLerp = 1 - Math.pow(1 - 0.12, dt * 60);
    if (this._pointerDown) {
      const pxPerIndex = 340;
      const dragIdx = -this._dragDeltaX / pxPerIndex;
      const target = clamp(this._index + dragIdx, 0, Math.max(0, this.ships.length - 1));
      // Follow pointer quickly.
      const dragLerp = 1 - Math.pow(1 - 0.35, dt * 60);
      this._scroll = THREE.MathUtils.lerp(this._scroll, target, dragLerp);
    } else {
      this._scroll = THREE.MathUtils.lerp(this._scroll, this._index, scrollLerp);
    }

    // Animate key light sweep a bit for depth.
    if (this._key) {
      this._key.position.x = 140 * this.worldScale + Math.sin(t * 0.6) * 60 * this.worldScale;
      this._key.position.z = 180 * this.worldScale + Math.cos(t * 0.5) * 45 * this.worldScale;
    }

    // Dust drift
    if (this._dust) this._dust.rotation.y = t * 0.04;

    // Position ships as a carousel in the hangar.
    const spacing = this._spacing ?? 200;
    for (let i = 0; i < this.shipEntries.length; i++) {
      const e = this.shipEntries[i];
      const delta = i - this._scroll;
      const abs = Math.abs(delta);

      const x = delta * spacing;
      const z = -abs * 80 * this.worldScale;
      const y = 12.0 * this.voxelSize;

      e.group.position.x = THREE.MathUtils.lerp(e.group.position.x, x, scrollLerp);
      e.group.position.z = THREE.MathUtils.lerp(e.group.position.z, z, scrollLerp);
      e.group.position.y = y;

      // Big center ship, smaller sides.
      const targetScale = THREE.MathUtils.lerp(2.1, 1.15, clamp(abs / 2.2, 0, 1));
      e.group.scale.setScalar(THREE.MathUtils.lerp(e.group.scale.x, targetScale, scrollLerp));

      // Subtle rotation for life; center ship rotates a bit more.
      const centerW = 1 - clamp(abs / 1.2, 0, 1);
      const idleRot = Math.sin(t * 0.8) * 0.06 * centerW;
      const spin = t * 0.55 * centerW; // selected ship rotates
      e.group.rotation.y = Math.PI + delta * 0.15 + idleRot + spin;
    }

    // Render
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
