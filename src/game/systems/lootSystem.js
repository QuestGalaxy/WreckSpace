import * as THREE from 'three';

export class LootSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this._dir = new THREE.Vector3();

    // Scratch for marker layout.
    this._tmpLootWorld = new THREE.Vector3();
    this._tmpCamSpace = new THREE.Vector3();
    this._tmpWorldScale = new THREE.Vector3();
    this._tmpInvQuat = new THREE.Quaternion();

    // Throttle marker layout updates to reduce jitter from camera shake.
    this._markerLayoutAcc = 0;
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    this.updateLoot(dtSec, nowSec);
    this.checkDeposit();
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  updateLoot(dtSec, nowSec) {
    const g = this.game;
    const k = dtSec * 60;
    const ws = g.worldScale ?? 1;
    if (!g.playerEntityId) return;
    const playerT = g.world.transform.get(g.playerEntityId);
    if (!playerT) return;

    this._markerLayoutAcc += dtSec;
    const doLayout = this._markerLayoutAcc >= 1 / 15; // 15Hz marker layout
    if (doLayout) this._markerLayoutAcc = 0;

    for (const [entityId, meta] of g.world.loot) {
      const t = g.world.transform.get(entityId);
      const v = g.world.velocity.get(entityId);
      const m = g.world.lootMotion.get(entityId);
      if (!t || !v || !m) continue;

      // 1) Physics (drift)
      t.x += v.x * k;
      t.y += v.y * k;
      t.z += v.z * k;
      const drag = Math.pow(0.95, k);
      v.x *= drag;
      v.y *= drag;
      v.z *= drag;

      // 2) Floating animation (absolute, avoids accumulated drift)
      t.y = m.floatBaseY + Math.sin(nowSec * 2 + m.driftOffset) * 0.02;

      // 3) Rotation
      t.rx += m.rotationSpeed.x * k;
      t.ry += m.rotationSpeed.y * k;
      t.rz += m.rotationSpeed.z * k;

      // 4) Magnet + collect check (player still lives in Three for now)
      const dx = playerT.x - t.x;
      const dy = playerT.y - t.y;
      const dz = playerT.z - t.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Make pickups feel generous: pull from farther and collect sooner.
      const magnetRange = 90 * ws;
      const collectRange = 12 * ws;

      if (dist < magnetRange && dist > 0.0001) {
        const inv = 1 / dist;
        const pullFactor = 1 - dist / magnetRange;
        const magnetStrength = pullFactor * 3.5 * k;
        t.x += dx * inv * magnetStrength;
        t.y += dy * inv * magnetStrength;
        t.z += dz * inv * magnetStrength;

        if (dist < 18 * ws) {
          const shrink = Math.pow(0.9, k);
          t.sx *= shrink;
          t.sy *= shrink;
          t.sz *= shrink;
        }
      }

      // Sync mesh from world state (render side) and update ring visuals.
      const lootObj = g.renderRegistry.get(entityId);
      if (lootObj) {
        lootObj.position.set(t.x, t.y, t.z);
        lootObj.rotation.set(t.rx, t.ry, t.rz);
        lootObj.scale.set(t.sx, t.sy, t.sz);

        // Marker root cancels loot rotation/scale so ring/label do not wobble (coin is non-uniform).
        const markerRoot = lootObj.userData?.markerRoot ?? null;
        if (markerRoot) {
          const sx = Math.max(0.0001, lootObj.scale.x);
          const sy = Math.max(0.0001, lootObj.scale.y);
          const sz = Math.max(0.0001, lootObj.scale.z);
          markerRoot.scale.set(1 / sx, 1 / sy, 1 / sz);
          markerRoot.quaternion.copy(lootObj.quaternion).invert();
        }

        const ring = lootObj.userData?.ring;
        const label = lootObj.userData?.label;
        if (ring) {
          // Always readable: don't let depth occlusion hide the marker.
          if (ring.material) {
            ring.material.depthTest = false;
            ring.material.depthWrite = false;
          }

          // Show markers within a configurable range only (reduce clutter).
          const markerRange = 320 * ws;
          const forced = (lootObj.userData?.forceMarkerUntilSec ?? 0) > nowSec;
          const visible = forced || dist <= markerRange;
          ring.visible = visible;
          if (label) label.visible = visible;

          // Stable opacity (no pulse) + fade with distance (reduces "busy" movement).
          const distT = visible ? (1 - dist / markerRange) : 0;
          if (ring.material) ring.material.opacity = 0.14 + 0.52 * distT;

          if (doLayout) {
            // Make ring face the camera but ignore camera roll (keeps the indicator from rotating during shake).
            ring.up.set(0, 1, 0);
            ring.lookAt(g.camera.position);

            // Keep ring roughly constant on screen (like a HUD marker).
            this._layoutLootRing(ring, ws);
          }
        }

        if (label) {
          if (doLayout) this._layoutLootLabel(label, ws);
        }
      }

      if (dist < collectRange) {
        this.collectLootEntity(entityId, meta.value);
      }
    }
  }

  collectLootEntity(entityId, value) {
    const g = this.game;
    if (g.stats.storage >= g.stats.maxStorage) {
      g.showMessage('Storage Full! Return to base.');
      return;
    }

    // Remove simulation entity first; mesh may be pooled.
    g.world.removeEntity(entityId);

    g.stats.storage += 1;
    g.stats.loot += value;
    g.soundManager.playCollect();
    const lootObj = g.renderRegistry.get(entityId);
    if (lootObj) {
      g.scene.remove(lootObj);
      if (g.spawner?.releaseLoot) g.spawner.releaseLoot(lootObj);
    }
    g.updateHudStats();
  }

  checkDeposit() {
    const g = this.game;
    if (!g.playerEntityId || !g.baseStation) return;
    const ws = g.worldScale ?? 1;
    const t = g.world.transform.get(g.playerEntityId);
    if (!t) return;
    const dx = t.x - g.baseStation.position.x;
    const dy = t.y - g.baseStation.position.y;
    const dz = t.z - g.baseStation.position.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 30 * ws) {
      if (g.stats.storage > 0) this.depositLoot();
    }
  }

  depositLoot() {
    const g = this.game;
    g.isPaused = true;
    if (g.hud) g.hud.setBaseMenuVisible(true);
    g.stats.storage = 0;
    g.soundManager.playDeposit();
    g.showMessage('Loot deposited! Energy refilled.');
    g.updateHudStats();
  }

  _layoutLootRing(ring, ws) {
    const g = this.game;
    if (!g.camera) return;
    if (!ring) return;

    ring.getWorldPosition(this._tmpLootWorld);
    this._tmpCamSpace.copy(this._tmpLootWorld).applyMatrix4(g.camera.matrixWorldInverse);
    const depth = Math.max(0.001, -this._tmpCamSpace.z);

    const vh = g.renderer?.domElement?.clientHeight || window.innerHeight || 720;
    const fovRad = THREE.MathUtils.degToRad(g.camera.fov);
    const worldHeight = 2 * depth * Math.tan(fovRad * 0.5);
    const unitsPerPx = worldHeight / vh;

    // Desired on-screen ring size.
    const desiredPx = 28;
    const desiredWorld = desiredPx * unitsPerPx;
    const baseSize = ring.userData?.baseSize ?? ring.parent?.parent?.userData?.baseRingSize ?? 3.0;
    const s = desiredWorld / Math.max(0.0001, baseSize);
    // Smooth scaling to avoid visible jitter.
    const a = 0.28;
    const cur = ring.scale.x || 0;
    const next = cur > 0 ? THREE.MathUtils.lerp(cur, s, a) : s;
    ring.scale.setScalar(next);

    void ws;
  }

  _layoutLootLabel(label, ws) {
    const g = this.game;
    if (!g.camera) return;
    if (!label) return;

    label.getWorldPosition(this._tmpLootWorld);
    this._tmpCamSpace.copy(this._tmpLootWorld).applyMatrix4(g.camera.matrixWorldInverse);
    const depth = Math.max(0.001, -this._tmpCamSpace.z);

    const vh = g.renderer?.domElement?.clientHeight || window.innerHeight || 720;
    const fovRad = THREE.MathUtils.degToRad(g.camera.fov);
    const worldHeight = 2 * depth * Math.tan(fovRad * 0.5);
    const unitsPerPx = worldHeight / vh;

    // Desired on-screen label size.
    const desiredPxW = 96;
    const desiredPxH = 18;
    const desiredWorldW = desiredPxW * unitsPerPx;
    const desiredWorldH = desiredPxH * unitsPerPx;
    // Smooth scaling to avoid jitter.
    const a = 0.28;
    const curW = label.scale.x || 0;
    const curH = label.scale.y || 0;
    const nextW = curW > 0 ? THREE.MathUtils.lerp(curW, desiredWorldW, a) : desiredWorldW;
    const nextH = curH > 0 ? THREE.MathUtils.lerp(curH, desiredWorldH, a) : desiredWorldH;
    label.scale.set(nextW, nextH, 1);

    // Float above the loot (keep pixel-based, stable).
    const padPx = 10;
    const padWorld = padPx * unitsPerPx;
    label.position.set(0, padWorld, 0);

    // Ensure label isn't occluded.
    if (label.material) {
      label.material.depthTest = false;
      label.material.depthWrite = false;
    }
  }
}
