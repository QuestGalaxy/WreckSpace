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
    this._bulletPos = new THREE.Vector3();
    this._noseOffset = new THREE.Vector3(0, 0, 2);
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
    if (!g.player || !g.camera) return;

    let bestTarget = null;
    let bestAngle = 0.25; // Slightly wider cone
    const maxDist = 500; // Increased range

    this._forward.set(0, 0, 1).applyQuaternion(g.player.quaternion).normalize();
    const playerPos = g.player.position;

    for (const obj of g.objects) {
      this._dirToObj.subVectors(obj.position, playerPos);
      const dist = this._dirToObj.length();
      if (dist > maxDist) continue;

      this._dirToObj.normalize();
      const angle = 1 - this._forward.dot(this._dirToObj); // 0 means perfectly aligned
      if (angle < bestAngle) {
        bestAngle = angle;
        bestTarget = obj;
      }
    }

    g.currentTarget = bestTarget;

    if (!g.hud) return;
    if (g.currentTarget) {
      g.hud.crosshairSetLocked(true);
      this._targetPos.copy(g.currentTarget.position).project(g.camera);
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
    if (!g.player) return;
    if (!g.scene) return;

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
    this._bulletPos.copy(this._noseOffset).applyMatrix4(g.player.matrixWorld);
    bullet.position.copy(this._bulletPos);

    // Direction and rotation
    let forward;
    if (g.currentTarget) {
      forward = this._dirToObj.subVectors(g.currentTarget.position, this._bulletPos).normalize();
      bullet.lookAt(g.currentTarget.position);
    } else {
      forward = this._forward.set(0, 0, 1).applyQuaternion(g.player.quaternion);
      bullet.quaternion.copy(g.player.quaternion);
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

      // Collision with objects
      for (let j = g.objects.length - 1; j >= 0; j--) {
        const obj = g.objects[j];
        if (b.position.distanceTo(obj.position) < obj.scale.x) {
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
          const entityId = obj.userData.entityId;
          const h = entityId ? g.world.damage(entityId, g.shipData.weaponPower) : null;

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
            g.destroyObject(obj, j);
          }
          break;
        }
      }
    }
  }
}
