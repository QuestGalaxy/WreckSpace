import * as THREE from 'three';

export class VfxSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    /** @type {Map<string, THREE.CanvasTexture>} */
    this._glowTextureCache = new Map();

    // Simple pool to reduce per-frame allocations for very frequent particles.
    /** @type {THREE.Mesh[]} */
    this._engineTrailPool = [];
    this._engineTrailPoolLimit = 600;

    this._engineTrailGeo = new THREE.BoxGeometry(1, 1, 1); // unit cube, scaled per instance

    /** @type {THREE.Mesh[]} */
    this._smokePool = [];
    /** @type {THREE.Mesh[]} */
    this._sparkPool = [];
    /** @type {THREE.Mesh[]} */
    this._fireballPool = [];
    /** @type {THREE.Mesh[]} */
    this._hitSparkPool = [];

    this._smokePoolLimit = 800;
    this._sparkPoolLimit = 2000;
    this._fireballPoolLimit = 400;
    this._hitSparkPoolLimit = 600;

    this._smokeGeo = new THREE.BoxGeometry(1, 1, 1); // scaled per instance
    this._sparkGeo = new THREE.BoxGeometry(1, 1, 1); // scaled per instance
    this._fireballGeo = new THREE.BoxGeometry(1, 1, 1); // scaled per instance
  }

  /**
   * Engine trail particle spawn with pooling.
   * @param {THREE.Vector3} position
   * @param {boolean} isBoosting
   */
  spawnEngineTrail(position, isBoosting) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    const ws = g.worldScale ?? 1;
    const size = (isBoosting ? 0.6 : 0.25) * ws;
    const color = isBoosting ? 0x00ffff : 0x0088ff;
    const baseOpacity = isBoosting ? 0.8 : 0.4;
    const life = isBoosting ? 25 : 15;

    let p = this._engineTrailPool.pop() ?? null;
    if (!p) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: baseOpacity,
        blending: THREE.AdditiveBlending
      });
      p = new THREE.Mesh(this._engineTrailGeo, mat);
    } else {
      // Reset pooled instance
      p.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = baseOpacity;
    }

    p.position.copy(position);
    p.scale.setScalar(size);

    // Random scatter (wider spread when boosting)
    const spread = isBoosting ? 0.3 : 0.15;
    p.position.x += (Math.random() - 0.5) * spread;
    p.position.y += (Math.random() - 0.5) * spread;
    p.position.z += (Math.random() - 0.5) * spread;

    p.userData = {
      life,
      isEngineTrail: true,
      // Used by pooling on death.
      _poolKind: 'engineTrail'
    };

    g.scene.add(p);
    g.particles.push(p);
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number} size
   */
  spawnSmoke(position, size) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    let smoke = this._smokePool.pop() ?? null;
    if (!smoke) {
      smoke = new THREE.Mesh(
        this._smokeGeo,
        new THREE.MeshBasicMaterial({
          color: 0x666666,
          transparent: true,
          opacity: 0.4
        })
      );
    } else {
      smoke.visible = true;
      smoke.material.color.setHex(0x666666);
      smoke.material.opacity = 0.4;
    }

    smoke.position.copy(position);
    smoke.scale.setScalar(size);
    smoke.userData = { life: 30, isSmoke: true, _poolKind: 'smoke' };

    g.scene.add(smoke);
    g.particles.push(smoke);
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number} size
   * @param {number} color
   * @param {boolean} additive
   */
  spawnFireball(position, size, color, additive = true) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    let fireball = this._fireballPool.pop() ?? null;
    if (!fireball) {
      fireball = new THREE.Mesh(
        this._fireballGeo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 1.0,
          blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
        })
      );
    } else {
      fireball.visible = true;
      fireball.material.color.setHex(color);
      fireball.material.opacity = 1.0;
      fireball.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    }

    fireball.position.copy(position);
    fireball.scale.setScalar(size);

    const initialLife = 40 + Math.random() * 40;
    fireball.userData = {
      isFireball: true,
      velocity: new THREE.Vector3(0, 0, 0),
      expandSpeed: 1.02 + Math.random() * 0.03,
      life: initialLife,
      initialLife,
      _poolKind: 'fireball'
    };

    g.scene.add(fireball);
    g.particles.push(fireball);
    return fireball;
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number} size
   * @param {number} color
   */
  spawnSpark(position, size, color) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    let spark = this._sparkPool.pop() ?? null;
    if (!spark) {
      spark = new THREE.Mesh(
        this._sparkGeo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 1.0
        })
      );
    } else {
      spark.visible = true;
      spark.material.color.setHex(color);
      spark.material.opacity = 1.0;
    }

    spark.position.copy(position);
    spark.scale.setScalar(size);
    spark.userData = { life: 15 + Math.random() * 20, _poolKind: 'spark', velocity: new THREE.Vector3(0, 0, 0) };

    g.scene.add(spark);
    g.particles.push(spark);
    return spark;
  }

  /**
   * @param {THREE.Vector3} position
   */
  spawnHitSpark(position) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    let s = this._hitSparkPool.pop() ?? null;
    if (!s) {
      s = new THREE.Mesh(
        this._smokeGeo,
        new THREE.MeshBasicMaterial({
          color: 0x00ffff,
          transparent: true,
          opacity: 0.5
        })
      );
    } else {
      s.visible = true;
      s.material.color.setHex(0x00ffff);
      s.material.opacity = 0.5;
    }

    s.position.copy(position);
    s.scale.setScalar(0.03);
    s.userData = {
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * 1.5
      ),
      life: 8 + Math.random() * 8,
      _poolKind: 'hitSpark'
    };

    g.scene.add(s);
    g.particles.push(s);
  }

  /**
   * Updates particle simulation (fragments, smoke, shockwaves, fireballs, engine trails).
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    const g = this.game;
    if (!g.particles || g.particles.length === 0) return;

    // Convert "per-60Hz-tick" tuning to dt-aware behavior.
    const k = dtSec * 60;

    for (let i = g.particles.length - 1; i >= 0; i--) {
      const p = g.particles[i];

      if (p.userData.velocity) {
        p.position.addScaledVector(p.userData.velocity, k);
      }

      if (p.userData.isFragment) {
        p.rotation.x += p.userData.rotVelocity.x * k;
        p.rotation.y += p.userData.rotVelocity.y * k;
        p.rotation.z += p.userData.rotVelocity.z * k;
        p.userData.velocity.multiplyScalar(Math.pow(0.98, k));

        // Smoke trail for debris.
        if (Math.random() > 0.7) {
          this.spawnSmoke(p.position, p.scale.x * 0.5);
        }
      } else if (p.userData.isSmoke) {
        p.scale.multiplyScalar(Math.pow(1.02, k));
        p.material.opacity *= Math.pow(0.95, k);
      } else if (p.userData.isShockwave) {
        const initialLife = p.userData.initialLife ?? 40;
        const progress = 1 - p.userData.life / initialLife; // 0..1
        const base = p.userData.baseScale ?? 1;
        const scale = base * (1 + progress * initialLife * p.userData.expandSpeed);
        p.scale.set(scale, scale, p.scale.z);
        p.material.opacity = Math.max(0, p.userData.life / initialLife);
      } else if (p.userData.isFireball) {
        p.scale.multiplyScalar(Math.pow(p.userData.expandSpeed, k));

        const initialLife = p.userData.initialLife ?? 40;
        const lifeRatio = p.userData.life / initialLife;
        if (lifeRatio > 0.8) p.material.color.setHex(0xffffff);
        else if (lifeRatio > 0.6) p.material.color.setHex(0xffff00);
        else if (lifeRatio > 0.4) p.material.color.setHex(0xffaa00);
        else p.material.color.setHex(0xff4400);

        p.material.opacity = lifeRatio;
      } else if (p.userData.isEngineTrail) {
        p.scale.multiplyScalar(Math.pow(0.9, k));
        p.material.opacity *= Math.pow(0.9, k);
      } else {
        // Dust physics: scale down
        p.scale.multiplyScalar(Math.pow(0.96, k));
      }

      p.userData.life -= k;
      if (p.userData.life <= 0) {
        g.scene.remove(p);
        g.particles.splice(i, 1);

        const kind = p.userData._poolKind;
        if (kind === 'engineTrail') {
          if (this._engineTrailPool.length < this._engineTrailPoolLimit) {
            p.visible = false;
            p.userData = {};
            this._engineTrailPool.push(p);
          }
        } else if (kind === 'fragment') {
          if (g.spawner?.releaseFragment) g.spawner.releaseFragment(p);
        } else if (kind === 'smoke') {
          if (this._smokePool.length < this._smokePoolLimit) {
            p.visible = false;
            p.userData = {};
            this._smokePool.push(p);
          }
        } else if (kind === 'spark') {
          if (this._sparkPool.length < this._sparkPoolLimit) {
            p.visible = false;
            p.userData = {};
            this._sparkPool.push(p);
          }
        } else if (kind === 'fireball') {
          if (this._fireballPool.length < this._fireballPoolLimit) {
            p.visible = false;
            p.userData = {};
            this._fireballPool.push(p);
          }
        } else if (kind === 'hitSpark') {
          if (this._hitSparkPool.length < this._hitSparkPoolLimit) {
            p.visible = false;
            p.userData = {};
            this._hitSparkPool.push(p);
          }
        }
      }
    }

    void nowSec;
  }

  /**
   * Small cached helper for glowy sprites.
   * @param {string} color
   */
  createGlowTexture(color) {
    const cached = this._glowTextureCache.get(color);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.2, color);
    gradient.addColorStop(0.5, 'rgba(0,0,0,0.1)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);

    const tex = new THREE.CanvasTexture(canvas);
    this._glowTextureCache.set(color, tex);
    return tex;
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number} size
   * @param {string} type
   */
  createExplosion(position, size, type) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    const isPlanet = type === 'planet';

    // 1. Core Shockwave (Expanding slab; voxel-friendly)
    const ringGeo = new THREE.BoxGeometry(1, 1, 0.25);
    const ringMat = new THREE.MeshBasicMaterial({
      color: isPlanet ? 0xff4400 : 0xffaa44,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(position);
    if (g.camera) ring.lookAt(g.camera.position);
    g.scene.add(ring);

    const ringLife = isPlanet ? 80 : 40;
    const baseScale = size * (isPlanet ? 1.2 : 0.9);
    ring.scale.set(baseScale, baseScale, 1);
    ring.userData = {
      isShockwave: true,
      baseScale,
      expandSpeed: isPlanet ? 0.028 : 0.06,
      life: ringLife,
      initialLife: ringLife
    };
    g.particles.push(ring);

    // 1.5 Second Shockwave (Vertical for Planets)
    if (isPlanet) {
      const ring2 = ring.clone();
      ring2.rotation.x = Math.PI / 2;
      ring2.userData.expandSpeed *= 1.15;
      g.scene.add(ring2);
      g.particles.push(ring2);
    }

    // 2. Fireballs
    const fireballCount = isPlanet ? 25 : 5;
    for (let i = 0; i < fireballCount; i++) {
      const color = isPlanet ? (Math.random() > 0.5 ? 0xff0000 : 0xffaa00) : 0xffffff;
      const radius = size * (isPlanet ? 0.3 : 0.2);
      const fireball = this.spawnFireball(position, radius, color, true);

      const dir = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).normalize();
      fireball.userData.velocity.copy(dir).multiplyScalar(Math.random() * size * (isPlanet ? 0.1 : 0.3));
    }

    // 3. High Velocity Sparks
    const sparkCount = Math.floor(size * (isPlanet ? 30 : 15));
    for (let i = 0; i < sparkCount; i++) {
      const sparkSize = isPlanet ? 0.5 : 0.2;
      const sparkColor = isPlanet ? 0xff8800 : 0xffdd44;
      const p = this.spawnSpark(position, sparkSize, sparkColor);
      p.userData.velocity.set(
        (Math.random() - 0.5) * size * (isPlanet ? 1.5 : 2.5),
        (Math.random() - 0.5) * size * (isPlanet ? 1.5 : 2.5),
        (Math.random() - 0.5) * size * (isPlanet ? 1.5 : 2.5)
      );
    }
  }

  /**
   * @param {THREE.Vector3} position
   */
  createHitEffect(position) {
    const g = this.game;
    if (!g.particles) g.particles = [];

    for (let i = 0; i < 3; i++) {
      this.spawnHitSpark(position);
    }

    if (g.hud) g.hud.crosshairPulseHit();
    g.cameraShake = 0.3;
  }
}
