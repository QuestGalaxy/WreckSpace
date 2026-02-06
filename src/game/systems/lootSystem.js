import * as THREE from 'three';

export class LootSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this._dir = new THREE.Vector3();
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

        const ring = lootObj.userData?.ring;
        if (ring) {
          ring.rotation.z += 0.05 * k;
          ring.material.opacity = 0.4 + Math.sin(nowSec * 5) * 0.2;
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
}
