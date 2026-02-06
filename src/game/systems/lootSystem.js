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
    void dtSec;
    this.updateLoot(nowSec);
    this.checkDeposit();
  }

  /**
   * @param {number} nowSec
   */
  updateLoot(nowSec) {
    const g = this.game;

    for (let i = g.lootItems.length - 1; i >= 0; i--) {
      const loot = g.lootItems[i];

      // 1. Physics: Move based on velocity (Drifting)
      if (loot.userData.velocity) {
        loot.position.add(loot.userData.velocity);
        loot.userData.velocity.multiplyScalar(0.95); // Drag to slow down to a halt
      }

      // 2. Gentle floating animation (Sine wave)
      loot.position.y += Math.sin(nowSec * 2 + loot.userData.driftOffset) * 0.02;

      // 3. Rotation
      loot.rotation.x += loot.userData.rotationSpeed.x;
      loot.rotation.y += loot.userData.rotationSpeed.y;
      loot.rotation.z += loot.userData.rotationSpeed.z;

      // Rotate the holographic ring
      const ring = loot.userData.ring ?? loot.children.find((c) => c.userData.isLootRing);
      if (ring) {
        ring.rotation.z += 0.05;
        ring.material.opacity = 0.4 + Math.sin(nowSec * 5) * 0.2;
      }

      // Magnet effect if close
      const dist = loot.position.distanceTo(g.player.position);
      const magnetRange = 50;

      if (dist < magnetRange) {
        this._dir.subVectors(g.player.position, loot.position).normalize();
        const pullFactor = 1 - dist / magnetRange; // 0..1
        const magnetStrength = pullFactor * 2.0;
        loot.position.add(this._dir.multiplyScalar(magnetStrength));

        if (dist < 10) loot.scale.multiplyScalar(0.9);
      }

      if (dist < 5) {
        this.collectLoot(loot, i);
      }
    }
  }

  collectLoot(loot, index) {
    const g = this.game;
    if (g.stats.storage >= g.stats.maxStorage) {
      g.showMessage('Storage Full! Return to base.');
      return;
    }

    // Remove simulation entity first; mesh may be pooled.
    if (loot.userData?.entityId) g.world.removeEntity(loot.userData.entityId);

    g.stats.storage += 1;
    g.stats.loot += loot.userData.value;
    g.soundManager.playCollect();
    g.scene.remove(loot);
    g.lootItems.splice(index, 1);
    if (g.spawner?.releaseLoot) g.spawner.releaseLoot(loot);
    g.updateHudStats();
  }

  checkDeposit() {
    const g = this.game;
    if (!g.player || !g.baseStation) return;
    if (g.player.position.distanceTo(g.baseStation.position) < 30) {
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
