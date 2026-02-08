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
    this._glitch = 0;

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
      hull: document.getElementById('ship-hull'),
      speed: document.getElementById('ship-speed'),
      cargo: document.getElementById('ship-storage'),
      warp: document.getElementById('ship-warp'),
      hullBar: document.getElementById('ship-hull-bar'),
      speedBar: document.getElementById('ship-speed-bar'),
      cargoBar: document.getElementById('ship-storage-bar'),
      warpBar: document.getElementById('ship-warp-bar')
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
    if (next !== this._index) {
      this._glitch = 1.0;
    }
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
      if (
        target &&
        typeof target.closest === 'function' &&
        target.closest('button, input, label, .hangar-mode')
      ) {
        return;
      }

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
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Avoid filmic/realistic grading; CRT pass handles style.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Keep bloom very subtle to avoid haze.
    this._bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.15, 0.05, 0.6);
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
      metalness: 0.65, // More reflective for premium look
      roughness: 0.28, // Smoother for sharper specular highlights
      flatShading: true,
      vertexColors: true
    });
  }

  _buildHangar() {
    const ws = this.worldScale;

    // Lights
    // DRAMATIC LIGHTING: Much lower ambient to let spotlights and rim lights shine
    this.scene.add(new THREE.AmbientLight(0x222233, 0.25));

    const key = new THREE.DirectionalLight(0xffffff, 1.8); // Brighter key
    key.position.set(140 * ws, 220 * ws, 180 * ws);
    key.target.position.set(0, 0, 0);
    this.scene.add(key);
    this.scene.add(key.target);
    this._key = key;

    const fill = new THREE.DirectionalLight(0xffe8cc, 0.45); // Lower fill for more contrast
    fill.position.set(120 * ws, 110 * ws, 260 * ws);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0x66ccff, 1.8); // Stronger rim light for silhouette pop
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

    // Floating dust motes
    const dustGeo = new THREE.BufferGeometry();
    const count = 1200;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      arr[ix] = (Math.random() - 0.5) * 1200 * ws;
      arr[ix + 1] = Math.random() * 600 * ws;
      arr[ix + 2] = (Math.random() - 0.5) * 1200 * ws;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: 0x66ccff, size: 2.5, transparent: true, opacity: 0.3, sizeAttenuation: true })
    );
    this.scene.add(dust);
    this._dust = dust;

    // Holographic platform under the ship
    const holoGeo = new THREE.CylinderGeometry(100 * ws, 110 * ws, 5 * ws, 32);
    const holoMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      wireframe: true
    });
    this._holoPlatform = new THREE.Mesh(holoGeo, holoMat);
    this._holoPlatform.position.y = 2 * ws;
    this.scene.add(this._holoPlatform);

    // Inner glow for platform
    const innerHoloGeo = new THREE.CylinderGeometry(95 * ws, 95 * ws, 1 * ws, 32);
    const innerHoloMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending
    });
    this._innerHolo = new THREE.Mesh(innerHoloGeo, innerHoloMat);
    this._innerHolo.position.y = 3 * ws;
    this.scene.add(this._innerHolo);

    // Add a spotlight above the selected ship
    this._spotlight = new THREE.SpotLight(0xffffff, 80.0); // MASSIVE intensity for punch
    this._spotlight.position.set(0, 320 * ws, 80 * ws);
    this._spotlight.angle = Math.PI / 9; // Slightly sharper
    this._spotlight.penumbra = 0.5;
    this._spotlight.decay = 1.2; 
    this._spotlight.distance = 2000 * ws;
    this._spotlight.target.position.set(0, 12 * this.voxelSize, 0); 
    this.scene.add(this._spotlight);
    this.scene.add(this._spotlight.target);

    // Add a point light at the ship's center for a "glow from within/under" effect
    this._shipGlow = new THREE.PointLight(0x66ccff, 6.5, 300 * ws); // Even stronger glow
    this._shipGlow.position.set(0, 12 * this.voxelSize, 0);
    this.scene.add(this._shipGlow);

    // Volumetric spotlight cone with a gradient
    const coneGeo = new THREE.CylinderGeometry(8 * ws, 160 * ws, 450 * ws, 32, 20, true);
    
    // Add vertex colors for gradient
    const count_colors = coneGeo.attributes.position.count;
    const colors = new Float32Array(count_colors * 3);
    const pos = coneGeo.attributes.position;
    for (let i = 0; i < count_colors; i++) {
      const y = pos.getY(i);
      // Normalized Y from -225 to 225 -> 0 to 1
      const alpha = (y + 225 * ws) / (450 * ws);
      const intensity = Math.pow(alpha, 4.0); // Very sharp falloff to keep top clean
      colors[i * 3] = 0.4 * intensity; // Bluer, more saturated
      colors[i * 3 + 1] = 0.7 * intensity;
      colors[i * 3 + 2] = 1.0 * intensity;
    }
    coneGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const coneMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.10, // Lower opacity to avoid "gray filter"
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexColors: true,
      depthWrite: false
    });
    this._spotCone = new THREE.Mesh(coneGeo, coneMat);
    this._spotCone.position.set(0, 225 * ws, 0);
    this.scene.add(this._spotCone);

    // Add a secondary thinner "core" beam
    const coreGeo = new THREE.CylinderGeometry(2 * ws, 45 * ws, 420 * ws, 16, 1, true);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x88ddff,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this._spotCore = new THREE.Mesh(coreGeo, coreMat);
    this._spotCore.position.set(0, 200 * ws, 0);
    this.scene.add(this._spotCore);

    // Add some hanging cables for detail
    const cableMat = this._voxLit({ color: 0x1a1a1a, emissive: 0x000000 });
    for (let i = 0; i < 8; i++) {
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(1 * ws, 1 * ws, 600 * ws), cableMat);
      const angle = (i / 8) * Math.PI * 2;
      const radius = 500 * ws;
      cable.position.set(Math.cos(angle) * radius, 300 * ws, Math.sin(angle) * radius);
      cable.rotation.z = (Math.random() - 0.5) * 0.2;
      this.scene.add(cable);
    }

    // Add some distant "tech" boxes
    const boxMat = this._voxLit({ color: 0x2a2a2a, map: this.textures.panelsDark });
    for (let i = 0; i < 12; i++) {
      const size = (20 + Math.random() * 40) * ws;
      const box = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), boxMat);
      box.position.set(
        (Math.random() - 0.5) * 1500 * ws,
        Math.random() * 400 * ws,
        -600 * ws - Math.random() * 400 * ws
      );
      box.rotation.set(Math.random(), Math.random(), Math.random());
      this.scene.add(box);
    }
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
    else if (ship.id === 'balanced') shipClass = 'Standard Class';
    else if (ship.id === 'miner') shipClass = 'Industrial Class';

    if (this.el.name) this.el.name.textContent = ship.name;
    if (this.el.klass) this.el.klass.textContent = shipClass;
    if (this.el.desc) this.el.desc.textContent = ship.description ?? '';

    if (this.el.hull) this.el.hull.textContent = String(ship.hull ?? 0);
    if (this.el.speed) this.el.speed.textContent = String(ship.speed ?? 0);
    if (this.el.cargo) this.el.cargo.textContent = String(ship.cargo ?? 0);
    if (this.el.warp) this.el.warp.textContent = String(ship.warpCooldownSec ?? 0);

    const hullPct = ((ship.hull ?? 0) / 200) * 100;
    const speedPct = ((ship.speed ?? 0) / 1.5) * 100;
    const cargoPct = ((ship.cargo ?? 0) / 120) * 100;
    // Lower cooldown is better: invert into a "bigger is better" bar.
    const warpBase = 6;
    const warpMax = 18;
    const warpVal = ship.warpCooldownSec ?? warpMax;
    const warpPct = (1 - (warpVal - warpBase) / Math.max(1e-6, warpMax - warpBase)) * 100;

    // Animate bars
    const setBar = (el, pct) => {
      if (!el) return;
      el.style.width = `${clamp(pct, 0, 100)}%`;
    };
    setBar(this.el.hullBar, hullPct);
    setBar(this.el.speedBar, speedPct);
    setBar(this.el.cargoBar, cargoPct);
    setBar(this.el.warpBar, warpPct);
  }

  _tick(nowMs) {
    this._raf = requestAnimationFrame((t) => this._tick(t));
    const dt = Math.min(0.05, (nowMs - (this._tPrev || nowMs)) / 1000);
    this._tPrev = nowMs;
    const t = nowMs / 1000;

    // Glitch decay
    this._glitch = Math.max(0, this._glitch - dt * 2.5);

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
      this._key.intensity = 1.15 + (Math.random() < 0.05 ? this._glitch * 2 : 0);
    }

    if (this._bloom) {
      this._bloom.strength = 0.18 + this._glitch * 0.8;
    }

    // Camera shake on glitch
    if (this._glitch > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * 2 * this._glitch * this.worldScale;
      this.camera.position.y += (Math.random() - 0.5) * 2 * this._glitch * this.worldScale;
    } else {
      // Return to base position
      const basePos = new THREE.Vector3(18 * this.worldScale, 66 * this.worldScale, 182 * this.worldScale);
      this.camera.position.lerp(basePos, 0.1);
    }

    // Dust drift
    if (this._dust) {
      this._dust.rotation.y = t * 0.04;
      this._dust.position.y = Math.sin(t * 0.2) * 10 * this.worldScale;
    }

    // Animate holographic platform
    if (this._holoPlatform) {
      this._holoPlatform.rotation.y = t * 0.5;
      this._holoPlatform.material.opacity = 0.15 + Math.sin(t * 2) * 0.05;
    }
    if (this._innerHolo) {
      this._innerHolo.scale.setScalar(1 + Math.sin(t * 4) * 0.02);
    }

    if (this._spotlight) {
      this._spotlight.intensity = (40.0 + Math.sin(t * 10) * 5.0 * this._glitch);
    }
    if (this._shipGlow) {
      this._shipGlow.intensity = 3.5 + Math.sin(t * 3) * 0.8;
    }
    if (this._spotCone) {
      this._spotCone.material.opacity = (0.10 + Math.sin(t * 5) * 0.02) * (1 + this._glitch);
      this._spotCone.rotation.y = t * 0.12; // Slow rotation for shimmer
    }
    if (this._spotCore) {
      this._spotCore.material.opacity = (0.05 + Math.sin(t * 8) * 0.01) * (1 + this._glitch);
    }

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
