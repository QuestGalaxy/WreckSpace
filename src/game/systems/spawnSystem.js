import * as THREE from 'three';

export class SpawnSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;

    // Reused geometries; scale instances instead of allocating new geometry per spawn.
    this._fragmentGeo = new THREE.IcosahedronGeometry(1, 0);
    this._gemGeo = new THREE.IcosahedronGeometry(1, 0);
    this._coinGeo = new THREE.BoxGeometry(1, 1, 1);

    /** @type {THREE.Mesh[]} */
    this._fragmentPool = [];
    /** @type {THREE.Mesh[]} */
    this._gemLootPool = [];
    /** @type {THREE.Mesh[]} */
    this._coinLootPool = [];

    this._fragmentPoolLimit = 200;
    this._lootPoolLimit = 200;
  }

  /**
   * Spawns debris fragments and loot for a destroyed object.
   * Caller owns removing the destroyed object from the scene/arrays.
   * @param {THREE.Mesh} obj
   */
  spawnOnDestroyed(obj) {
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
  spawnLoot(obj) {
    const g = this.game;
    const count = obj.userData.type === 'planet' ? 20 : 3;

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
      const baseScale = loot.userData.baseScale;
      loot.userData = { ring, glow, baseScale, entityId };

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

  releaseLoot(loot) {
    if (!loot) return;
    const kind = loot.userData?.type;
    const entityId = loot.userData?.entityId;
    if (entityId) this.game.renderRegistry.unbind(entityId);
    loot.visible = false;
    loot.userData = { ring: loot.userData?.ring, glow: loot.userData?.glow };

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

  _acquireGemLoot() {
    const g = this.game;
    const loot = this._gemLootPool.pop() ?? null;
    if (loot) {
      loot.visible = true;
      loot.scale.setScalar(2.0);
      loot.material.color.setHex(0x00ffff);
      loot.material.emissive.setHex(0x00ffff);
      loot.material.emissiveIntensity = 1.5;
      loot.material.metalness = 0.9;
      loot.material.roughness = 0.0;
      return loot;
    }

    const mat = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 1.5,
      metalness: 0.9,
      roughness: 0.0
    });
    const mesh = new THREE.Mesh(this._gemGeo, mat);
    mesh.scale.setScalar(2.0);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: g.vfx.createGlowTexture('#00ffff'),
        color: 0x00ffff,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending
      })
    );
    glow.scale.set(12, 12, 1);
    mesh.add(glow);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.0, 0.03, 8, 64),
      new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
      })
    );
    ring.userData = { isLootRing: true };
    ring.rotation.x = Math.PI / 2;
    mesh.add(ring);

    const light = new THREE.PointLight(0x00ffff, 5, 10);
    mesh.add(light);

    mesh.userData = { ring, glow, baseScale: { x: 2.0, y: 2.0, z: 2.0 } };
    return mesh;
  }

  _acquireCoinLoot() {
    const g = this.game;
    const loot = this._coinLootPool.pop() ?? null;
    if (loot) {
      loot.visible = true;
      loot.scale.set(1.5, 0.8, 2.5);
      loot.material.color.setHex(0xffd700);
      loot.material.emissive.setHex(0xffaa00);
      loot.material.emissiveIntensity = 0.8;
      loot.material.metalness = 1.0;
      loot.material.roughness = 0.2;
      return loot;
    }

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffd700,
      emissive: 0xffaa00,
      emissiveIntensity: 0.8,
      metalness: 1.0,
      roughness: 0.2
    });
    const mesh = new THREE.Mesh(this._coinGeo, mat);
    mesh.scale.set(1.5, 0.8, 2.5);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: g.vfx.createGlowTexture('#ffaa00'),
        color: 0xffaa00,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending
      })
    );
    glow.scale.set(12, 12, 1);
    mesh.add(glow);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.03, 8, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
      })
    );
    ring.userData = { isLootRing: true };
    ring.rotation.x = Math.PI / 2;
    mesh.add(ring);

    mesh.userData = { ring, glow, baseScale: { x: 1.5, y: 0.8, z: 2.5 } };
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
}
