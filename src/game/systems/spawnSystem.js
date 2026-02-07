import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export class SpawnSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;

    // Reused geometries; scale instances instead of allocating new geometry per spawn.
    this._fragmentGeo = new THREE.BoxGeometry(1, 1, 1);
    // Loot visuals: keep them cheap but distinct (no heavy post FX needed).
    this._gemGeo = new THREE.BoxGeometry(1, 1, 1);
    this._coinGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.22, 14, 1, false);
    this._voxelDebrisGeo = new THREE.BoxGeometry(1, 1, 1);

    /** @type {THREE.Mesh[]} */
    this._fragmentPool = [];
    /** @type {THREE.Mesh[]} */
    this._gemLootPool = [];
    /** @type {THREE.Mesh[]} */
    this._coinLootPool = [];
    /** @type {THREE.Mesh[]} */
    this._voxelDebrisPool = [];

    this._fragmentPoolLimit = 200;
    this._lootPoolLimit = 200;
    this._voxelDebrisPoolLimit = 1600;

    // Scratch
    this._tmpL = new THREE.Vector3();
    this._tmpW = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpDir2 = new THREE.Vector3();

    // Scratch colors for debris tinting (avoid allocations in hot paths).
    this._tmpColor = new THREE.Color();
    this._tmpColor2 = new THREE.Color();

    // Cached canvas labels for loot markers (higher res -> sharper text).
    this._lootLabelCanvasSize = { w: 512, h: 128 };

    // Marker visibility grace period after spawn (seconds).
    this._lootMarkerGraceSec = 15;
    this._lootMarkerGraceExplosionSec = 20;
  }

  _getLootWorldSize() {
    // Define loot size in world units: match one voxel cube edge length.
    return this.game?.voxel?.size ?? 5.0;
  }

  _getLootScaleForKind(kind) {
    const size = this._getLootWorldSize();
    if (kind === 'gem') {
      // Unit cube -> scale to side length.
      return size;
    }
    // Unit cylinder has diameter 1.4 (radius 0.7) -> scale so diameter matches.
    return size / 1.4;
  }

  /**
   * Spawns debris fragments and loot for a destroyed object.
   * Caller owns removing the destroyed object from the scene/arrays.
   * @param {THREE.Mesh} obj
   */
  spawnOnDestroyed(obj) {
    // Voxel bodies get a dedicated \"cube explosion\"; don't also spawn large fragments (too noisy).
    if (obj?.userData?.voxel?.filled) {
      this.spawnVoxelExplosion(obj);
      // Loot is now driven mainly by resource voxels; keep a tiny bonus sprinkle so destruction still rewards.
      this.spawnLoot(obj, { scale: 0.25 });
      return;
    }

    this.spawnFragments(obj);
    this.spawnLoot(obj);
  }

  /**
   * @param {THREE.Mesh} obj
   */
  spawnFragments(obj) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    const fragmentCount = obj.userData.type === 'planet' ? 12 : 5;
    for (let i = 0; i < fragmentCount; i++) {
      const fragSize = (Math.random() * 0.5 + 0.5) * (obj.scale.x * 0.4);
      const fragment = this._acquireFragment(obj);
      fragment.scale.setScalar(fragSize);

      fragment.position.copy(obj.position);
      fragment.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

      fragment.userData = {
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 1.5,
          (Math.random() - 0.5) * 1.5,
          (Math.random() - 0.5) * 1.5
        ),
        rotVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.1,
          (Math.random() - 0.5) * 0.1,
          (Math.random() - 0.5) * 0.1
        ),
        life: 200 + Math.random() * 100,
        isFragment: true,
        _poolKind: 'fragment'
      };

      g.scene.add(fragment);
      g.particles.push(fragment);
    }
  }

  /**
   * @param {THREE.Mesh} obj
   */
  spawnLoot(obj, opts = {}) {
    const g = this.game;
    const scale = opts.scale ?? 1.0;
    const baseCount = obj.userData.type === 'planet' ? 20 : 3;
    const count = Math.max(0, Math.floor(baseCount * scale));
    const nowSec = g._simTimeSec ?? 0;

    for (let i = 0; i < count; i++) {
      const isGem = Math.random() > 0.8;

      const loot = isGem ? this._acquireGemLoot() : this._acquireCoinLoot();
      loot.position.copy(obj.position);
      loot.rotation.set(0, 0, 0);
      // Scale is reset inside acquire() to the correct base (pooled instances may have been shrunk).

      const entityId = g.world.createLoot({ type: isGem ? 'gem' : 'coin', value: isGem ? 50 : 10 });
      g.renderRegistry.bind(entityId, loot);

      const sprayDir = new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2
      )
        .normalize()
        .multiplyScalar(Math.random() * 20 + 10);

      // Simulation state lives in World; keep mesh userData for render-only handles.
      const ring = loot.userData.ring;
      const glow = loot.userData.glow;
      const label = loot.userData.label;
      const markerRoot = loot.userData.markerRoot;
      const baseRingSize = loot.userData.baseRingSize;
      const forceMarkerUntilSec = nowSec + this._lootMarkerGraceSec;
      const baseScale = loot.userData.baseScale;
      loot.userData = {
        ring,
        glow,
        label,
        markerRoot,
        baseRingSize,
        forceMarkerUntilSec,
        baseScale,
        entityId,
        type: isGem ? 'gem' : 'coin',
        value: isGem ? 50 : 10
      };

      if (label) {
        const txt = isGem ? `Gem +50` : `Coin +10`;
        this._setLootLabelText(label, txt, isGem ? 0x00ffff : 0xffaa00);
        label.visible = true;
      }

      g.world.transform.set(entityId, {
        x: loot.position.x,
        y: loot.position.y,
        z: loot.position.z,
        rx: 0,
        ry: 0,
        rz: 0,
        sx: loot.scale.x,
        sy: loot.scale.y,
        sz: loot.scale.z
      });
      g.world.velocity.set(entityId, { x: sprayDir.x, y: sprayDir.y, z: sprayDir.z });
      g.world.lootMotion.set(entityId, {
        rotationSpeed: {
          x: (Math.random() - 0.5) * 0.15,
          y: (Math.random() - 0.5) * 0.15,
          z: (Math.random() - 0.5) * 0.15
        },
        driftOffset: Math.random() * 100,
        floatBaseY: loot.position.y
      });

      g.scene.add(loot);
    }
  }

  /**
   * Called from VoxelDestructionSystem: small cube burst at the hit point.
   * @param {{obj: THREE.Mesh, hitWorldPos: THREE.Vector3, bulletVelWorld: THREE.Vector3, debrisPositions: THREE.Vector3[], resourcePositions: THREE.Vector3[]}} info
   */
  spawnVoxelImpact(info) {
    const g = this.game;
    const { obj, hitWorldPos, bulletVelWorld, debrisPositions, resourcePositions } = info;
    if (!g.scene) return;
    const nowSec = g._simTimeSec ?? 0;

    const vox = obj?.userData?.voxel;
    const ws = g.worldScale ?? 1;
    const cellWorld = (obj.scale.x ?? 1) * (vox?.voxelSizeOriginal ?? 1) * (vox?.normScale ?? 1);
    const cubeSize = THREE.MathUtils.clamp(cellWorld * 0.65, 0.45 * ws, 6 * ws);

    // Debris cubes (particles)
    const maxDebris = obj.userData.type === 'planet' ? 16 : 9;
    const nDebris = Math.min(maxDebris, debrisPositions.length);

    for (let i = 0; i < nDebris; i++) {
      const p = debrisPositions[i];
      const debris = this._acquireVoxelDebris(obj);
      this._tintVoxelDebrisToSource(debris, obj);
      debris.position.copy(p);
      debris.scale.setScalar(cubeSize * (0.85 + Math.random() * 0.35));
      debris.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

      this._tmpDir.copy(p).sub(obj.position).normalize();
      this._tmpDir2.copy(bulletVelWorld).normalize();
      this._tmpW.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5));
      this._tmpDir
        .multiplyScalar(0.85)
        .addScaledVector(this._tmpDir2, 0.28)
        .addScaledVector(this._tmpW, 0.45)
        .normalize();

      // Keep impact debris readable: slower + tighter spread.
      const speed = (obj.userData.type === 'planet' ? 0.04 : 0.08) * (obj.scale.x ?? 1) + (2.2 * ws);
      const life = (obj.userData.type === 'planet' ? 70 : 45) + Math.random() * 35;
      debris.userData = {
        isVoxelDebris: true,
        velocity: new THREE.Vector3().copy(this._tmpDir).multiplyScalar(speed * (0.55 + Math.random() * 0.55)),
        rotVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.14,
          (Math.random() - 0.5) * 0.14,
          (Math.random() - 0.5) * 0.14
        ),
        life,
        initialLife: life,
        baseOpacity: 0.98,
        _poolKind: 'voxelDebris'
      };

      g.scene.add(debris);
      g.particles.push(debris);
    }

    // Resource cubes become collectible loot (gems/coins) thrown outward.
    const maxLoot = obj.userData.type === 'planet' ? 7 : 3;
    const nLoot = Math.min(maxLoot, resourcePositions.length);
    for (let i = 0; i < nLoot; i++) {
      const p = resourcePositions[i];
      const isGem = Math.random() > 0.55;
      const loot = isGem ? this._acquireGemLoot() : this._acquireCoinLoot();
      loot.position.copy(p);
      loot.rotation.set(0, 0, 0);

      const entityId = g.world.createLoot({ type: isGem ? 'gem' : 'coin', value: isGem ? 50 : 10 });
      g.renderRegistry.bind(entityId, loot);

      this._tmpDir.copy(p).sub(obj.position).normalize();
      const vel = this._tmpDir.multiplyScalar((obj.userData.type === 'planet' ? 0.05 : 0.10) * (obj.scale.x ?? 1) + (7 * ws));

      const ring = loot.userData.ring;
      const glow = loot.userData.glow;
      const label = loot.userData.label;
      const markerRoot = loot.userData.markerRoot;
      const baseRingSize = loot.userData.baseRingSize;
      const forceMarkerUntilSec = nowSec + this._lootMarkerGraceSec;
      const baseScale = loot.userData.baseScale;
      loot.userData = {
        ring,
        glow,
        label,
        markerRoot,
        baseRingSize,
        forceMarkerUntilSec,
        baseScale,
        entityId,
        type: isGem ? 'gem' : 'coin',
        value: isGem ? 50 : 10
      };

      if (label) {
        const txt = isGem ? `Gem +50` : `Coin +10`;
        this._setLootLabelText(label, txt, isGem ? 0x00ffff : 0xffaa00);
        label.visible = true;
      }

      g.world.transform.set(entityId, {
        x: loot.position.x,
        y: loot.position.y,
        z: loot.position.z,
        rx: 0,
        ry: 0,
        rz: 0,
        sx: loot.scale.x,
        sy: loot.scale.y,
        sz: loot.scale.z
      });
      g.world.velocity.set(entityId, { x: vel.x, y: vel.y, z: vel.z });
      g.world.lootMotion.set(entityId, {
        rotationSpeed: {
          x: (Math.random() - 0.5) * 0.15,
          y: (Math.random() - 0.5) * 0.15,
          z: (Math.random() - 0.5) * 0.15
        },
        driftOffset: Math.random() * 100,
        floatBaseY: loot.position.y
      });

      g.scene.add(loot);
    }

    void hitWorldPos;
  }

  /**
   * If a voxel object is carved fully away (filled set hits 0 before HP logic triggers),
   * we still want a satisfying final cube burst.
   * @param {{obj: THREE.Mesh, hitWorldPos: THREE.Vector3, bulletVelWorld: THREE.Vector3}} info
   */
  spawnVoxelFinalBurst(info) {
    const g = this.game;
    const { obj, hitWorldPos, bulletVelWorld } = info;
    if (!g.scene) return;

    const vox = obj?.userData?.voxel;
    const ws = g.worldScale ?? 1;
    const cellWorld = (obj.scale.x ?? 1) * (vox?.voxelSizeOriginal ?? 1) * (vox?.normScale ?? 1);
    const cubeSize = THREE.MathUtils.clamp(cellWorld * 0.8, 0.65 * ws, 8 * ws);

    const isPlanet = obj.userData.type === 'planet';
    const count = isPlanet ? 160 : 55;

    const velN = this._tmpDir2.copy(bulletVelWorld).normalize();
    for (let i = 0; i < count; i++) {
      const debris = this._acquireVoxelDebris(obj);
      this._tintVoxelDebrisToSource(debris, obj);
      this._tmpW.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5));
      debris.position.copy(hitWorldPos).addScaledVector(this._tmpW, cubeSize * (0.7 + Math.random() * 0.9));
      debris.scale.setScalar(cubeSize * (0.65 + Math.random() * 0.65));
      debris.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

      this._tmpDir.copy(debris.position).sub(obj.position).normalize();
      this._tmpDir.addScaledVector(velN, 0.25).addScaledVector(this._tmpW, 0.25).normalize();

      const speed = (isPlanet ? 0.06 : 0.12) * (obj.scale.x ?? 1) + (8.5 * ws);
      const life = (isPlanet ? 180 : 120) + Math.random() * (isPlanet ? 160 : 80);
      debris.userData = {
        isVoxelDebris: true,
        velocity: new THREE.Vector3().copy(this._tmpDir).multiplyScalar(speed * (0.5 + Math.random() * 0.45)),
        rotVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.22,
          (Math.random() - 0.5) * 0.22,
          (Math.random() - 0.5) * 0.22
        ),
        life,
        initialLife: life,
        baseOpacity: 0.98,
        _poolKind: 'voxelDebris'
      };
      g.scene.add(debris);
      g.particles.push(debris);
    }
  }

  /**
   * Full-destruction: lots of small cubes thrown outward from remaining voxels.
   * @param {THREE.Mesh} obj
   */
  spawnVoxelExplosion(obj) {
    const g = this.game;
    if (!g.scene) return;
    if (!g.particles) g.particles = [];
    const nowSec = g._simTimeSec ?? 0;

    const vox = obj?.userData?.voxel;
    if (!vox?.filled || vox.filled.size === 0) return;

    const ws = g.worldScale ?? 1;
    const isPlanet = obj.userData.type === 'planet';
    const cellWorld = (obj.scale.x ?? 1) * (vox.voxelSizeOriginal ?? 1) * (vox.normScale ?? 1);
    const cubeSize = THREE.MathUtils.clamp(cellWorld * 0.7, 0.55 * ws, 7 * ws);

    // Sample remaining voxels for debris positions.
    const maxDebris = isPlanet ? 220 : 50;
    const keys = this._sampleFromSet(vox.filled, maxDebris);
    const debrisPositions = this._keysToWorldPositions(obj, vox, keys);

    for (let i = 0; i < debrisPositions.length; i++) {
      const p = debrisPositions[i];
      const debris = this._acquireVoxelDebris(obj);
      this._tintVoxelDebrisToSource(debris, obj);
      debris.position.copy(p);
      debris.scale.setScalar(cubeSize * (0.75 + Math.random() * 0.55));
      debris.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

      this._tmpDir.copy(p).sub(obj.position).normalize();
      this._tmpW.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5));
      this._tmpDir.addScaledVector(this._tmpW, 0.45).normalize();

      // Big explosion should still read \"chunky\", but not eject cubes into infinity.
      const speed = (isPlanet ? 0.05 : 0.10) * (obj.scale.x ?? 1) + (5.5 * ws);
      const life = (isPlanet ? 140 : 95) + Math.random() * (isPlanet ? 120 : 70);
      debris.userData = {
        isVoxelDebris: true,
        velocity: new THREE.Vector3().copy(this._tmpDir).multiplyScalar(speed * (0.5 + Math.random() * 0.45)),
        rotVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.18,
          (Math.random() - 0.5) * 0.18,
          (Math.random() - 0.5) * 0.18
        ),
        life,
        initialLife: life,
        baseOpacity: 0.98,
        _poolKind: 'voxelDebris'
      };
      g.scene.add(debris);
      g.particles.push(debris);
    }

    // Remaining resource voxels become loot.
    if (vox.resource && vox.resource.size > 0) {
      const maxLoot = isPlanet ? 20 : 8;
      const lootKeys = this._sampleFromSet(vox.resource, maxLoot);
      const lootPositions = this._keysToWorldPositions(obj, vox, lootKeys);
      for (let i = 0; i < lootPositions.length; i++) {
        const p = lootPositions[i];
        const isGem = Math.random() > 0.5;
        const loot = isGem ? this._acquireGemLoot() : this._acquireCoinLoot();
        loot.position.copy(p);
        loot.rotation.set(0, 0, 0);

        const entityId = g.world.createLoot({ type: isGem ? 'gem' : 'coin', value: isGem ? 50 : 10 });
        g.renderRegistry.bind(entityId, loot);

        this._tmpDir.copy(p).sub(obj.position).normalize();
        const vel = this._tmpDir.multiplyScalar((isPlanet ? 0.06 : 0.12) * (obj.scale.x ?? 1) + (12 * ws));

        const ring = loot.userData.ring;
        const glow = loot.userData.glow;
        const label = loot.userData.label;
        const markerRoot = loot.userData.markerRoot;
        const baseRingSize = loot.userData.baseRingSize;
        const forceMarkerUntilSec = nowSec + this._lootMarkerGraceExplosionSec;
        const baseScale = loot.userData.baseScale;
        loot.userData = {
          ring,
          glow,
          label,
          markerRoot,
          baseRingSize,
          forceMarkerUntilSec,
          baseScale,
          entityId,
          type: isGem ? 'gem' : 'coin',
          value: isGem ? 50 : 10
        };

        if (label) {
          const txt = isGem ? `Gem +50` : `Coin +10`;
          this._setLootLabelText(label, txt, isGem ? 0x00ffff : 0xffaa00);
          label.visible = true;
        }

        g.world.transform.set(entityId, {
          x: loot.position.x,
          y: loot.position.y,
          z: loot.position.z,
          rx: 0,
          ry: 0,
          rz: 0,
          sx: loot.scale.x,
          sy: loot.scale.y,
          sz: loot.scale.z
        });
        g.world.velocity.set(entityId, { x: vel.x, y: vel.y, z: vel.z });
        g.world.lootMotion.set(entityId, {
          rotationSpeed: {
            x: (Math.random() - 0.5) * 0.15,
            y: (Math.random() - 0.5) * 0.15,
            z: (Math.random() - 0.5) * 0.15
          },
          driftOffset: Math.random() * 100,
          floatBaseY: loot.position.y
        });

        g.scene.add(loot);
      }
    }

    void cellWorld;
  }

  releaseVoxelDebris(mesh) {
    if (!mesh) return;
    mesh.visible = false;
    // Preserve material instance for reuse; userData reset on acquire.
    mesh.userData = {};
    if (this._voxelDebrisPool.length < this._voxelDebrisPoolLimit) this._voxelDebrisPool.push(mesh);
  }

  releaseLoot(loot) {
    if (!loot) return;
    const kind = loot.userData?.type;
    const entityId = loot.userData?.entityId;
    if (entityId) this.game.renderRegistry.unbind(entityId);
    loot.visible = false;
    loot.userData = {
      ring: loot.userData?.ring,
      glow: loot.userData?.glow,
      label: loot.userData?.label,
      markerRoot: loot.userData?.markerRoot,
      baseRingSize: loot.userData?.baseRingSize,
      type: kind
    };

    if (kind === 'gem') {
      if (this._gemLootPool.length < this._lootPoolLimit) this._gemLootPool.push(loot);
      return;
    }
    if (kind === 'coin') {
      if (this._coinLootPool.length < this._lootPoolLimit) this._coinLootPool.push(loot);
      return;
    }
  }

  releaseFragment(fragment) {
    if (!fragment) return;
    fragment.visible = false;
    fragment.userData = {};
    if (this._fragmentPool.length < this._fragmentPoolLimit) this._fragmentPool.push(fragment);
  }

  _acquireFragment(obj) {
    const srcMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;

    const frag = this._fragmentPool.pop() ?? null;
    if (frag) {
      frag.visible = true;
      this._copyStandardMaterial(frag.material, srcMat);
      return frag;
    }

    const mat = srcMat.clone();
    const mesh = new THREE.Mesh(this._fragmentGeo, mat);
    return mesh;
  }

  _acquireVoxelDebris(obj) {
    const srcMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const mesh = this._voxelDebrisPool.pop() ?? null;
    if (mesh) {
      mesh.visible = true;
      // Match color; keep it cheap (no vertexColors).
      if (mesh.material && srcMat && srcMat.color) mesh.material.color.copy(srcMat.color);
      if (mesh.material && srcMat && srcMat.map !== undefined) mesh.material.map = srcMat.map ?? null;
      if (mesh.material) {
        // Debris should feel like solid chunks of the body, not glowing VFX.
        if (mesh.material.emissive) mesh.material.emissive.setHex(0x000000);
        mesh.material.emissiveIntensity = 0.0;
        mesh.material.opacity = 0.98;
        mesh.material.transparent = true;
        mesh.material.vertexColors = false;
        mesh.material.needsUpdate = true;
      }
      return mesh;
    }

    const mat = new THREE.MeshStandardMaterial({
      color: srcMat?.color?.getHex?.() ?? 0x888888,
      map: srcMat?.map ?? null,
      emissive: 0x000000,
      emissiveIntensity: 0.0,
      roughness: srcMat?.roughness ?? 1.0,
      metalness: srcMat?.metalness ?? 0.0,
      flatShading: true,
      transparent: true,
      opacity: 0.98,
      vertexColors: false
    });
    return new THREE.Mesh(this._voxelDebrisGeo, mat);
  }

  _tintVoxelDebrisToSource(debris, srcObj) {
    const srcMat = Array.isArray(srcObj.material) ? srcObj.material[0] : srcObj.material;
    if (!debris?.material?.color || !srcMat?.color) return;

    // Keep hue the same but introduce subtle value variation so it reads as "real chunks".
    // Planet chunks: a bit tighter range (cleaner look); asteroid chunks: slightly wider (rocky).
    const isPlanet = srcObj?.userData?.type === 'planet';
    const f = isPlanet ? 0.92 + Math.random() * 0.12 : 0.86 + Math.random() * 0.22; // multiply in linear-ish space

    this._tmpColor.copy(srcMat.color);
    this._tmpColor2.copy(this._tmpColor).multiplyScalar(f);
    debris.material.color.copy(this._tmpColor2);

    // Start near-opaque; fade is handled in VfxSystem over lifetime.
    if (debris.material.opacity != null) debris.material.opacity = 0.98;
    debris.material.transparent = true;
  }

  _sampleFromSet(set, count) {
    const res = [];
    let i = 0;
    for (const k of set) {
      if (res.length < count) res.push(k);
      else {
        const j = Math.floor(Math.random() * (i + 1));
        if (j < count) res[j] = k;
      }
      i++;
    }
    return res;
  }

  _keysToWorldPositions(obj, vox, keys) {
    const cellLocal = (vox.voxelSizeOriginal ?? 1) * (vox.normScale ?? 1);
    const out = [];
    obj.updateMatrixWorld(true);
    for (const k of keys) {
      const [xs, ys, zs] = k.split(',');
      const x = Number(xs);
      const y = Number(ys);
      const z = Number(zs);
      this._tmpL.set(x * cellLocal, y * cellLocal, z * cellLocal);
      this._tmpW.copy(this._tmpL);
      obj.localToWorld(this._tmpW);
      out.push(this._tmpW.clone());
    }
    return out;
  }

  _acquireGemLoot() {
    const g = this.game;
    const loot = this._gemLootPool.pop() ?? null;
    const s = this._getLootScaleForKind('gem');
    if (loot) {
      loot.visible = true;
      loot.scale.setScalar(s);
      loot.material.color.setHex(0x61f4ff);
      loot.material.emissive.setHex(0x0b3a42);
      loot.material.emissiveIntensity = 0.2;
      loot.material.metalness = 0.25;
      loot.material.roughness = 0.35;
      this._ensureLootMarkerParts(loot, { kind: 'gem' });
      return loot;
    }

    const mat = new THREE.MeshStandardMaterial({
      color: 0x61f4ff,
      emissive: 0x0b3a42,
      emissiveIntensity: 0.2,
      metalness: 0.25,
      roughness: 0.35,
      flatShading: true
    });
    const mesh = new THREE.Mesh(this._gemGeo, mat);
    mesh.scale.setScalar(s);

    // Marker components (indicator + label) provide readability; keep the mesh itself clean.
    const ring = this._createLootIndicator({ size: 3.0, thickness: 0.085, arm: 0.95, color: 0x61f4ff, opacity: 0.65 });
    ring.userData = { isLootRing: true, baseSize: 3.0 };
    mesh.add(ring);

    mesh.userData = { ring, glow: null, baseScale: { x: s, y: s, z: s }, baseRingSize: 3.0 };
    this._ensureLootMarkerParts(mesh, { kind: 'gem' });
    void g;
    return mesh;
  }

  _acquireCoinLoot() {
    const g = this.game;
    const loot = this._coinLootPool.pop() ?? null;
    const s = this._getLootScaleForKind('coin');
    if (loot) {
      loot.visible = true;
      loot.scale.setScalar(s);
      loot.material.color.setHex(0xffd37a);
      loot.material.emissive.setHex(0x2a1a00);
      loot.material.emissiveIntensity = 0.2;
      loot.material.metalness = 0.35;
      loot.material.roughness = 0.45;
      this._ensureLootMarkerParts(loot, { kind: 'coin' });
      return loot;
    }

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffd37a,
      emissive: 0x2a1a00,
      emissiveIntensity: 0.2,
      metalness: 0.35,
      roughness: 0.45,
      flatShading: true
    });
    const mesh = new THREE.Mesh(this._coinGeo, mat);
    mesh.scale.setScalar(s);

    const ring = this._createLootIndicator({ size: 3.0, thickness: 0.085, arm: 0.95, color: 0xffc15e, opacity: 0.65 });
    ring.userData = { isLootRing: true, baseSize: 3.0 };
    mesh.add(ring);

    mesh.userData = { ring, glow: null, baseScale: { x: s, y: s, z: s }, baseRingSize: 3.0 };
    this._ensureLootMarkerParts(mesh, { kind: 'coin' });
    void g;
    return mesh;
  }

  _copyStandardMaterial(dst, src) {
    if (!dst || !src) return;
    if (!(dst instanceof THREE.MeshStandardMaterial) || !(src instanceof THREE.MeshStandardMaterial)) return;
    dst.color.copy(src.color);
    if (dst.emissive && src.emissive) dst.emissive.copy(src.emissive);
    dst.emissiveIntensity = src.emissiveIntensity ?? dst.emissiveIntensity;
    dst.roughness = src.roughness ?? dst.roughness;
    dst.metalness = src.metalness ?? dst.metalness;
  }

  _createLootIndicator({ size, thickness, arm, color, opacity }) {
    // "Bracket corners" indicator: new style, less noisy than a full ring.
    const segGeoH = new THREE.BoxGeometry(arm, thickness, thickness);
    const segGeoV = new THREE.BoxGeometry(thickness, arm, thickness);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false
    });

    const h = size * 0.5;
    const a = arm * 0.5;
    const t = thickness * 0.5;

    const parts = [];

    // TL
    {
      const top = segGeoH.clone();
      top.translate(-h + a, h - t, 0);
      const left = segGeoV.clone();
      left.translate(-h + t, h - a, 0);
      parts.push(top, left);
    }
    // TR
    {
      const top = segGeoH.clone();
      top.translate(h - a, h - t, 0);
      const right = segGeoV.clone();
      right.translate(h - t, h - a, 0);
      parts.push(top, right);
    }
    // BL
    {
      const bot = segGeoH.clone();
      bot.translate(-h + a, -h + t, 0);
      const left = segGeoV.clone();
      left.translate(-h + t, -h + a, 0);
      parts.push(bot, left);
    }
    // BR
    {
      const bot = segGeoH.clone();
      bot.translate(h - a, -h + t, 0);
      const right = segGeoV.clone();
      right.translate(h - t, -h + a, 0);
      parts.push(bot, right);
    }

    const merged = mergeGeometries(parts, false);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.renderOrder = 20;
    return mesh;
  }

  _ensureLootMarkerParts(mesh, { kind }) {
    if (!mesh) return;
    const g = this.game;

    // Marker root cancels loot mesh rotation/scale so ring/label stay stable (esp. coin's non-uniform scale).
    let markerRoot = mesh.userData?.markerRoot ?? null;
    if (!markerRoot) {
      markerRoot = new THREE.Object3D();
      markerRoot.renderOrder = 25;
      mesh.add(markerRoot);
    }

    const indicatorCfg =
      kind === 'gem'
        ? { size: 3.0, thickness: 0.085, arm: 0.95, color: 0x61f4ff, opacity: 0.65 }
        : { size: 3.0, thickness: 0.085, arm: 0.95, color: 0xffc15e, opacity: 0.65 };

    // Ring config: ensure it is always visible and tuned for the current worldScale.
    let ring = mesh.userData?.ring ?? null;
    if (!ring || ring.userData?.markerStyle !== 'bracket-v1') {
      if (ring?.parent) ring.parent.remove(ring);
      ring = this._createLootIndicator(indicatorCfg);
      ring.userData = { isLootRing: true, baseSize: indicatorCfg.size, markerStyle: 'bracket-v1' };
      mesh.add(ring);
      if (!mesh.userData) mesh.userData = {};
      mesh.userData.ring = ring;
      mesh.userData.baseRingSize = indicatorCfg.size;
    }

    if (ring?.material) {
      ring.material.depthTest = false;
      ring.material.depthWrite = false;
      ring.renderOrder = 20;
      ring.visible = true;
    }

    // Reset any pooled rotations so LootSystem can orient it consistently.
    ring.rotation.set(0, 0, 0);
    ring.quaternion.identity();
    ring.up.set(0, 1, 0);
    if (ring && ring.parent !== markerRoot) {
      markerRoot.add(ring);
    }

    // Label sprite: created once and updated per-entity in spawn sites (type/value text).
    let label = mesh.userData?.label ?? null;
    if (!label) {
      const canvas = document.createElement('canvas');
      canvas.width = this._lootLabelCanvasSize.w;
      canvas.height = this._lootLabelCanvasSize.h;
      const ctx = canvas.getContext('2d');

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;

      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.92,
        blending: THREE.NormalBlending,
        depthTest: false,
        depthWrite: false
      });
      label = new THREE.Sprite(mat);
      label.renderOrder = 30;
      label.userData._label = { canvas, ctx, tex };
      // Hide until a spawn site sets its text (avoids flashing "..." on pooled reuse).
      label.visible = false;
      markerRoot.add(label);
    } else {
      label.visible = false;
      if (label.material) {
        label.material.depthTest = false;
        label.material.depthWrite = false;
        label.material.blending = THREE.NormalBlending;
        label.renderOrder = 30;
      }
      if (label.parent !== markerRoot) {
        markerRoot.add(label);
      }
    }

    // Ensure userData references are present after pooling.
    if (!mesh.userData) mesh.userData = {};
    mesh.userData.label = label;
    mesh.userData.type = mesh.userData.type ?? kind;
    mesh.userData.markerRoot = markerRoot;

    // Default label colors; actual text is applied by spawn sites.
    if (kind === 'gem') this._setLootLabelText(label, 'GEM', 0x00ffff);
    else this._setLootLabelText(label, 'COIN', 0xffaa00);
    // Keep hidden until spawned.
    label.visible = false;

    // Make sure glow isn't occluded; it helps readability.
    const glow = mesh.userData?.glow ?? null;
    if (glow?.material) {
      glow.material.depthTest = false;
      glow.material.depthWrite = false;
      glow.renderOrder = 10;
      // Reduce bloom-y look around the marker.
      glow.material.opacity = Math.min(0.45, glow.material.opacity ?? 0.45);
    }

    void g;
  }

  _setLootLabelText(sprite, text, accentHex) {
    const info = sprite?.userData?._label;
    if (!sprite || !info) return;
    const { ctx, canvas, tex } = info;

    const accent = `#${(accentHex >>> 0).toString(16).padStart(6, '0')}`;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Text first (so we can size the backplate to the actual text width).
    ctx.font = 'bold 56px monospace';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(text);
    const textW = Math.max(1, metrics.width);

    // Compact backplate sized to the text (not full-width).
    const barH = Math.round(canvas.height * 0.56);
    const barY = Math.round((canvas.height - barH) * 0.5);
    const padX = 18;
    const accentW = 10;
    const bgW = Math.min(canvas.width - 24, Math.round(accentW + padX + textW + padX));
    const bgX = Math.round((canvas.width - bgW) * 0.5);

    // Backplate (slightly more opaque so bloom doesn't wash text out)
    ctx.fillStyle = 'rgba(6, 10, 18, 0.55)';
    ctx.fillRect(bgX, barY, bgW, barH);

    // Border (subtle)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 2;
    ctx.strokeRect(bgX + 1, barY + 1, bgW - 2, barH - 2);

    // Accent bar
    ctx.fillStyle = `${accent}CC`;
    ctx.fillRect(bgX + 2, barY + 2, accentW, barH - 4);

    // Text
    // Avoid pure white; keeps bloom pass from blowing out the glyphs.
    ctx.fillStyle = 'rgba(215, 232, 246, 0.92)';
    // No glow/shadow: keep labels crisp and non-bloomy.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText(text, bgX + 2 + accentW + padX, canvas.height / 2 + 2);
    ctx.shadowColor = 'transparent';

    tex.needsUpdate = true;
  }
}
