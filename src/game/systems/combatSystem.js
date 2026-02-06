import * as THREE from 'three';

export class CombatSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;

    // Scratch to avoid per-frame allocations.
    this._forward = new THREE.Vector3();
    this._dirToObj = new THREE.Vector3();
    this._targetPos = new THREE.Vector3();
    this._targetWorldPos = new THREE.Vector3();
    this._bulletPos = new THREE.Vector3();
    this._noseOffset = new THREE.Vector3(0, 0, 2);
    this._playerPos = new THREE.Vector3();
    this._playerQuat = new THREE.Quaternion();
    this._noseWorld = new THREE.Vector3();
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void nowSec;
    this.updateTargetLock();
    this.updateBullets(dtSec);
  }

  updateTargetLock() {
    const g = this.game;
    if (!g.playerEntityId || !g.camera) return;
    const pt = g.world.transform.get(g.playerEntityId);
    const prq = g.world.rotationQuat.get(g.playerEntityId);
    if (!pt || !prq) return;

    let bestTargetEntityId = null;
    let bestAngle = 0.25; // Slightly wider cone
    const maxDist = 500; // Increased range

    this._playerPos.set(pt.x, pt.y, pt.z);
    this._playerQuat.set(prq.x, prq.y, prq.z, prq.w);
    this._forward.set(0, 0, 1).applyQuaternion(this._playerQuat).normalize();

    for (const [entityId] of g.world.objectMeta) {
      const t = g.world.transform.get(entityId);
      if (!t) continue;
      this._dirToObj.set(t.x - this._playerPos.x, t.y - this._playerPos.y, t.z - this._playerPos.z);
      const dist = this._dirToObj.length();
      if (dist > maxDist) continue;

      this._dirToObj.normalize();
      const angle = 1 - this._forward.dot(this._dirToObj); // 0 means perfectly aligned
      if (angle < bestAngle) {
        bestAngle = angle;
        bestTargetEntityId = entityId;
      }
    }

    g.currentTargetEntityId = bestTargetEntityId;
    // Keep the old field for any transitional code.
    g.currentTarget = bestTargetEntityId ? g.renderRegistry.get(bestTargetEntityId) : null;

    if (!g.hud) return;
    if (g.currentTargetEntityId) {
      g.hud.crosshairSetLocked(true);
      const t = g.world.transform.get(g.currentTargetEntityId);
      if (!t) return;
      this._targetWorldPos.set(t.x, t.y, t.z);
      this._targetPos.copy(this._targetWorldPos).project(g.camera);
      const x = (this._targetPos.x * 0.5 + 0.5) * window.innerWidth;
      const y = (this._targetPos.y * -0.5 + 0.5) * window.innerHeight;
      g.hud.crosshairSetScreenPos(x, y);
      g.hud.crosshairSetLockedTransform();
    } else {
      g.hud.crosshairSetLocked(false);
      g.hud.crosshairResetToCenter();
    }
  }

  shoot() {
    const g = this.game;
    const now = Date.now();
    if (g.isPaused || g.stats.energy <= 0 || now - g.lastShotTime < g.fireRate) return;
    if (!g.playerEntityId) return;
    if (!g.scene) return;
    const pt = g.world.transform.get(g.playerEntityId);
    const prq = g.world.rotationQuat.get(g.playerEntityId);
    if (!pt || !prq) return;
    this._playerPos.set(pt.x, pt.y, pt.z);
    this._playerQuat.set(prq.x, prq.y, prq.z, prq.w);

    // Ensure audio is ready on first interaction
    g.soundManager.init();
    g.soundManager.playShoot();

    g.lastShotTime = now;
    if (g.hud) g.hud.crosshairPulseFiring();

    // Laser Geometry: Much beefier and longer for "Heavy Laser" feel
    const laserGeo = new THREE.CylinderGeometry(0.25, 0.25, 12, 8);
    laserGeo.rotateX(Math.PI / 2);

    const laserMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending
    });
    const bullet = new THREE.Mesh(laserGeo, laserMat);

    // Brighter Core
    const coreGeo = new THREE.CylinderGeometry(0.1, 0.1, 12.2, 8);
    coreGeo.rotateX(Math.PI / 2);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const core = new THREE.Mesh(coreGeo, coreMat);
    bullet.add(core);

    // Start exactly at the nose of the ship
    this._noseWorld.copy(this._noseOffset).applyQuaternion(this._playerQuat);
    this._bulletPos.copy(this._playerPos).add(this._noseWorld);
    bullet.position.copy(this._bulletPos);

    // Direction and rotation
    let forward;
    if (g.currentTargetEntityId) {
      const t = g.world.transform.get(g.currentTargetEntityId);
      if (t) {
        this._targetWorldPos.set(t.x, t.y, t.z);
        forward = this._dirToObj.subVectors(this._targetWorldPos, this._bulletPos).normalize();
        bullet.lookAt(this._targetWorldPos);
      } else {
        forward = this._forward.set(0, 0, 1).applyQuaternion(this._playerQuat);
        bullet.quaternion.copy(this._playerQuat);
      }
    } else {
      forward = this._forward.set(0, 0, 1).applyQuaternion(this._playerQuat);
      bullet.quaternion.copy(this._playerQuat);
    }

    bullet.userData = {
      // IMPORTANT: copy the direction vector. `_forward/_dirToObj` are scratch vectors reused
      // during target-lock updates; bullets need stable per-instance velocity.
      velocity: new THREE.Vector3().copy(forward).multiplyScalar(15), // per-tick velocity (fixed timestep @ 60Hz)
      life: 200
    };

    g.scene.add(bullet);
    g.bullets.push(bullet);

    // Muzzle Flash Effect
    const flashGeo = new THREE.SphereGeometry(0.5, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.copy(this._bulletPos);
    g.scene.add(flash);
    setTimeout(() => {
      g.scene.remove(flash);
    }, 50);

    // Feedback: Stronger Camera shake on fire
    g.cameraShake = 0.5;

    // Energy cost per shot (simple baseline; can become data-driven later).
    g.stats.energy = Math.max(0, g.stats.energy - g.shotEnergyCost);
    g.updateHudStats();
  }

  updateBullets(dtSec) {
    const g = this.game;
    if (!g.scene) return;
    const k = dtSec * 60;

    for (let i = g.bullets.length - 1; i >= 0; i--) {
      const b = g.bullets[i];
      b.position.addScaledVector(b.userData.velocity, k);
      b.userData.life--;

      if (b.userData.life <= 0) {
        g.scene.remove(b);
        g.bullets.splice(i, 1);
        continue;
      }

      // Collision with objects (world-first)
      const bx = b.position.x;
      const by = b.position.y;
      const bz = b.position.z;
      let hit = false;

      for (const [entityId] of g.world.objectMeta) {
        const t = g.world.transform.get(entityId);
        if (!t) continue;
        const dx = bx - t.x;
        const dy = by - t.y;
        const dz = bz - t.z;
        const dist2 = dx * dx + dy * dy + dz * dz;
        const radius = t.sx; // objects are uniformly scaled
        if (dist2 > radius * radius) continue;

        const obj = g.renderRegistry.get(entityId);
        if (!obj) continue;

          // Subtle hit flash
          if (obj.material) {
            const originalIntensity = obj.userData.type === 'planet' ? 0.1 : 0;
            const originalColor = obj.userData.type === 'planet' ? obj.material.color.getHex() : 0x000000;

            obj.material.emissive.setHex(0xffffff);
            obj.material.emissiveIntensity = 0.25; // Significantly reduced for elegance

            setTimeout(() => {
              if (obj && obj.material) {
                obj.material.emissiveIntensity = originalIntensity;
                obj.material.emissive.setHex(originalColor);
              }
            }, 60);
          }

          g.vfx.createHitEffect(b.position);
          g.soundManager.playHit();
          const h = g.world.damage(entityId, g.shipData.weaponPower);

          // Show and update health bar
          if (obj.userData.healthBar) {
            obj.userData.healthBar.sprite.visible = true;
            g.updateHealthBar(obj);

            // Hide after 3 seconds of no hits
            if (obj.userData.hbTimeout) clearTimeout(obj.userData.hbTimeout);
            obj.userData.hbTimeout = setTimeout(() => {
              if (obj.userData && obj.userData.healthBar) {
                obj.userData.healthBar.sprite.visible = false;
              }
            }, 3000);
          }

          g.scene.remove(b);
          g.bullets.splice(i, 1);

          if (h && h.hp <= 0) {
            g.destroyObjectEntity(entityId);
          }
          hit = true;
          break;
      }

      if (hit) continue;
    }
  }
}
