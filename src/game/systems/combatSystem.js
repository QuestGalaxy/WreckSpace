import * as THREE from 'three';

function key3(x, y, z) {
  return `${x},${y},${z}`;
}

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
    this._camSpace = new THREE.Vector3();
    this._hitLocal = new THREE.Vector3();

    // Screen-space crosshair smoothing (avoid jitter on distant targets + camera shake).
    this._crosshairX = null;
    this._crosshairY = null;
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    this.updateTargetLock(dtSec, nowSec);
    this.updateBullets(dtSec);
  }

  updateTargetLock(dtSec, nowSec) {
    const g = this.game;
    if (!g.playerEntityId || !g.camera) return;
    const pt = g.world.transform.get(g.playerEntityId);
    const prq = g.world.rotationQuat.get(g.playerEntityId);
    if (!pt || !prq) return;

    const ws = g.worldScale ?? 1;
    if ((g._lockSuppressUntilSec ?? 0) > nowSec) {
      g.currentTargetEntityId = null;
      if (g.hud) {
        if (g.hud.crosshairUnlockAndSnapToCenter) g.hud.crosshairUnlockAndSnapToCenter();
        else {
          g.hud.crosshairSetLocked(false);
          g.hud.crosshairResetToCenter();
        }
      }
      return;
    }

    // Scale target-lock range with the world scaling so voxel size changes don't break locking.
    const maxDist = 500 * ws;
    const screenMargin = 0.98; // NDC margin (avoid picking barely off-screen targets)

    // Sticky lock behavior:
    // - If we already have a target, keep it while it's reasonably near-center.
    // - If the player turns away (target drifts away from center), unlock.
    const keepCenterMax = 0.85;
    const acquireCenterMax = 0.60;

    this._playerPos.set(pt.x, pt.y, pt.z);
    this._playerQuat.set(prq.x, prq.y, prq.z, prq.w);
    this._forward.set(0, 0, 1).applyQuaternion(this._playerQuat).normalize();

    const isOnScreen = (t) => {
      this._targetWorldPos.set(t.x, t.y, t.z);
      this._camSpace.copy(this._targetWorldPos).applyMatrix4(g.camera.matrixWorldInverse);
      if (this._camSpace.z > 0) return false; // behind the camera
      this._targetPos.copy(this._targetWorldPos).project(g.camera);
      if (this._targetPos.z < -1 || this._targetPos.z > 1) return false;
      if (Math.abs(this._targetPos.x) > screenMargin || Math.abs(this._targetPos.y) > screenMargin) return false;
      return true;
    };

    const updateLockedHud = () => {
      if (!g.hud) return;

      // Convert NDC to screen-space px.
      const w = window.innerWidth;
      const h = window.innerHeight;
      const centerX = w * 0.5;
      const centerY = h * 0.5;
      const targetX = (this._targetPos.x * 0.5 + 0.5) * w;
      const targetY = (this._targetPos.y * -0.5 + 0.5) * h;

      // Distant targets tend to jitter more (float precision + camera shake).
      // Add distance-based smoothing and a slight "pull to center" so lock feels softer.
      const depth = Math.max(0.0001, -this._camSpace.z); // camera-space forward distance (positive)
      const depthNear = 80 * ws;
      const depthFar = maxDist;
      const depthT = THREE.MathUtils.clamp((depth - depthNear) / Math.max(0.0001, depthFar - depthNear), 0, 1);

      const pullToCenterNear = 0.0;
      const pullToCenterFar = 0.18;
      const pull = THREE.MathUtils.lerp(pullToCenterNear, pullToCenterFar, depthT);
      const desiredX = THREE.MathUtils.lerp(targetX, centerX, pull);
      const desiredY = THREE.MathUtils.lerp(targetY, centerY, pull);

      // Exponential smoothing (frame-rate independent).
      const followHzNear = 18;
      const followHzFar = 10;
      const followHz = THREE.MathUtils.lerp(followHzNear, followHzFar, depthT);
      const a = 1 - Math.exp(-Math.max(0, dtSec) * followHz);

      if (this._crosshairX == null || this._crosshairY == null) {
        this._crosshairX = desiredX;
        this._crosshairY = desiredY;
      } else {
        this._crosshairX = THREE.MathUtils.lerp(this._crosshairX, desiredX, a);
        this._crosshairY = THREE.MathUtils.lerp(this._crosshairY, desiredY, a);
      }

      g.hud.crosshairSetLocked(true);
      g.hud.crosshairSetScreenPos(this._crosshairX, this._crosshairY);
      g.hud.crosshairSetLockedTransform();
    };

    const unlock = () => {
      g.currentTargetEntityId = null;
      g._lockSuppressUntilSec = nowSec + 0.15;
      this._crosshairX = null;
      this._crosshairY = null;
      if (!g.hud) return;
      if (g.hud.crosshairUnlockAndSnapToCenter) g.hud.crosshairUnlockAndSnapToCenter();
      else {
        g.hud.crosshairSetLocked(false);
        g.hud.crosshairResetToCenter();
      }
    };

    // 1) Keep existing target if still valid and near-center.
    if (g.currentTargetEntityId) {
      const t = g.world.transform.get(g.currentTargetEntityId);
      if (!t) {
        unlock();
        return;
      }
      if (!isOnScreen(t)) {
        unlock();
        return;
      }
      const centerDist = Math.hypot(this._targetPos.x, this._targetPos.y);
      if (centerDist > keepCenterMax) {
        unlock();
        return;
      }

      // Still locked: update HUD position.
      updateLockedHud();
      return;
    }

    // 2) Acquire new target (on-screen, near center).
    let bestTargetEntityId = null;
    let bestScore = Infinity;
    const cone = 0.55;

    for (const [entityId] of g.world.objectMeta) {
      const t = g.world.transform.get(entityId);
      if (!t) continue;
      this._dirToObj.set(t.x - this._playerPos.x, t.y - this._playerPos.y, t.z - this._playerPos.z);
      const dist = this._dirToObj.length();
      if (dist > maxDist) continue;

      this._dirToObj.normalize();
      const angle = 1 - this._forward.dot(this._dirToObj); // 0 means perfectly aligned
      if (angle > cone) continue;

      if (!isOnScreen(t)) continue;

      const radius = t.sx ?? 1;
      const centerDist = Math.hypot(this._targetPos.x, this._targetPos.y); // NDC 0..~1.4
      if (centerDist > acquireCenterMax) continue;

      // Prefer on-screen center; add slight distance penalty; give big objects a small assist.
      const distPenalty = (dist / maxDist) * 0.25;
      const sizeAssist = Math.min(0.25, (radius / Math.max(1, dist)) * 0.5) * 0.25;
      const score = centerDist + distPenalty + angle * 0.35 - sizeAssist;
      if (score < bestScore) {
        bestScore = score;
        bestTargetEntityId = entityId;
      }
    }

    g.currentTargetEntityId = bestTargetEntityId;

    if (!g.hud) return;
    if (g.currentTargetEntityId) {
      const t = g.world.transform.get(g.currentTargetEntityId);
      if (!t) {
        // Target was destroyed mid-frame (lock runs before bullet collisions).
        unlock();
        return;
      }
      this._targetWorldPos.set(t.x, t.y, t.z);
      this._camSpace.copy(this._targetWorldPos).applyMatrix4(g.camera.matrixWorldInverse);
      this._targetPos.copy(this._targetWorldPos).project(g.camera);
      updateLockedHud();
    } else {
      this._crosshairX = null;
      this._crosshairY = null;
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

    // Muzzle position is ship-model dependent; default if not provided.
    const vox = g.voxel?.size ?? 1;
    if (g.shipMuzzleOffset) this._noseOffset.copy(g.shipMuzzleOffset);
    else this._noseOffset.set(0, 0, 2 * vox);

    // Ensure audio is ready on first interaction
    g.soundManager.init();
    g.soundManager.playShoot();

    g.lastShotTime = now;
    if (g.hud) g.hud.crosshairPulseFiring();

    // Voxel-ish laser: 1-voxel thick beam with a bright core + soft additive glow.
    const beamLen = 6 * vox;
    const beamThick = 1 * vox;

    const laserGeo = new THREE.BoxGeometry(beamThick, beamThick, beamLen);
    // Origin at the back of the beam so it starts at the ship nose.
    laserGeo.translate(0, 0, beamLen * 0.5);
    const laserMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending
    });
    const bullet = new THREE.Mesh(laserGeo, laserMat);

    const coreGeo = new THREE.BoxGeometry(beamThick * 0.42, beamThick * 0.42, beamLen * 1.02);
    coreGeo.translate(0, 0, beamLen * 0.5);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    bullet.add(new THREE.Mesh(coreGeo, coreMat));

    const glowGeo = new THREE.BoxGeometry(beamThick * 1.8, beamThick * 1.8, beamLen * 1.1);
    glowGeo.translate(0, 0, beamLen * 0.5);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    bullet.add(new THREE.Mesh(glowGeo, glowMat));

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

    const ws = g.worldScale ?? 1;
    bullet.userData = {
      // IMPORTANT: copy the direction vector. `_forward/_dirToObj` are scratch vectors reused
      // during target-lock updates; bullets need stable per-instance velocity.
      velocity: new THREE.Vector3().copy(forward).multiplyScalar(15 * ws), // per-tick velocity (fixed timestep @ 60Hz)
      life: 200
    };

    g.scene.add(bullet);
    g.bullets.push(bullet);

    // Muzzle Flash Effect (blocky)
    const flashGeo = new THREE.BoxGeometry(1.2 * vox, 1.2 * vox, 1.2 * vox);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending
    });
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
    const lockedId = g.currentTargetEntityId ?? null;
    const lockedType = lockedId ? (g.world.objectMeta.get(lockedId)?.type ?? null) : null;

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

      // If we're locked on a planet, ignore occluders so shots reliably reach it.
      const checkEntity = (entityId) => {
        const t = g.world.transform.get(entityId);
        if (!t) return false;
        const dx = bx - t.x;
        const dy = by - t.y;
        const dz = bz - t.z;
        const dist2 = dx * dx + dy * dy + dz * dz;
        const obj = g.renderRegistry.get(entityId);
        if (!obj) return false;

        // Use geometry radius if it changed due to voxel carving.
        const geoR = obj.geometry?.boundingSphere?.radius ?? 1;
        const radius = (t.sx ?? 1) * geoR; // objects are uniformly scaled
        if (dist2 > radius * radius) return false;

        // Voxel-aware hit test so shots pass through carved holes.
        const vox = obj.userData?.voxel;
        if (vox?.filled && vox.filled.size > 0) {
          obj.updateMatrixWorld(true);
          this._hitLocal.copy(b.position);
          obj.worldToLocal(this._hitLocal);
          const cellLocal = (vox.voxelSizeOriginal ?? 1) * (vox.normScale ?? 1);
          if (cellLocal > 0.000001) {
            const cx = Math.round(this._hitLocal.x / cellLocal);
            const cy = Math.round(this._hitLocal.y / cellLocal);
            const cz = Math.round(this._hitLocal.z / cellLocal);
            let ok = false;
            for (let dz2 = -1; dz2 <= 1 && !ok; dz2++) {
              for (let dy2 = -1; dy2 <= 1 && !ok; dy2++) {
                for (let dx2 = -1; dx2 <= 1; dx2++) {
                  if (vox.filled.has(key3(cx + dx2, cy + dy2, cz + dz2))) {
                    ok = true;
                    break;
                  }
                }
              }
            }
            if (!ok) return false;
          }
        }

          // Subtle hit flash
          if (obj.material) {
            const isPlanet = obj.userData.type === 'planet';
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            const saved = mats.map((m) => ({
              m,
              emissive: m?.emissive?.getHex?.() ?? null,
              intensity: typeof m?.emissiveIntensity === 'number' ? m.emissiveIntensity : null
            }));

            for (const m of mats) {
              if (!m?.emissive?.setHex) continue;
              m.emissive.setHex(0xffffff);
              m.emissiveIntensity = isPlanet ? 0.14 : 0.22;
            }

            setTimeout(() => {
              for (const s of saved) {
                const m = s.m;
                if (!m?.emissive?.setHex) continue;
                if (s.emissive != null) m.emissive.setHex(s.emissive);
                if (s.intensity != null) m.emissiveIntensity = s.intensity;
              }
            }, 60);
          }

          g.vfx.createHitEffect(b.position);
          g.soundManager.playHit();
          const h = g.world.damage(entityId, g.shipData.weaponPower);

          // Voxel destruction: pop cubes from the impact point and carve the object.
          if (g.voxelDestruction?.onHit) {
            g.voxelDestruction.onHit(entityId, b.position, b.userData.velocity, g.shipData.weaponPower);
          }

          // Sticky lock: if you hit a planet, lock it; turning away will release.
          if (obj.userData?.type === 'planet') {
            g.currentTargetEntityId = entityId;
          }

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
          return true;
      };

      if (lockedId && lockedType === 'planet') {
        hit = checkEntity(lockedId);
      } else {
        for (const [entityId] of g.world.objectMeta) {
          if (checkEntity(entityId)) {
            hit = true;
            break;
          }
        }
      }

      if (hit) continue;
    }
  }
}
