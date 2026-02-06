export class EnvironmentSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void nowSec;
    const g = this.game;
    this.updateObjectRotation(dtSec);
    this.syncObjectsFromWorld();
    this.updateSpaceDust();
  }

  updateObjectRotation(dtSec) {
    const g = this.game;
    const k = dtSec * 60;
    for (const [entityId, spin] of g.world.spin) {
      const t = g.world.transform.get(entityId);
      if (!t) continue;
      t.rx += spin.x * k;
      t.ry += spin.y * k;
      t.rz += spin.z * k;
    }
  }

  syncObjectsFromWorld() {
    const g = this.game;
    for (const [entityId] of g.world.objectMeta) {
      const obj = g.renderRegistry.get(entityId);
      const t = g.world.transform.get(entityId);
      if (!obj || !t) continue;
      obj.position.set(t.x, t.y, t.z);
      obj.rotation.set(t.rx, t.ry, t.rz);
      obj.scale.set(t.sx, t.sy, t.sz);
    }
  }

  updateSpaceDust() {
    const g = this.game;
    if (!g.spaceDustPoints || !g.player) return;

    const positions = g.spaceDustPoints.geometry.attributes.position.array;
    const range = 200;
    let needsUpdate = false;

    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < g.player.position.x - range) {
        positions[i] += range * 2;
        needsUpdate = true;
      } else if (positions[i] > g.player.position.x + range) {
        positions[i] -= range * 2;
        needsUpdate = true;
      }

      if (positions[i + 1] < g.player.position.y - range) {
        positions[i + 1] += range * 2;
        needsUpdate = true;
      } else if (positions[i + 1] > g.player.position.y + range) {
        positions[i + 1] -= range * 2;
        needsUpdate = true;
      }

      if (positions[i + 2] < g.player.position.z - range) {
        positions[i + 2] += range * 2;
        needsUpdate = true;
      } else if (positions[i + 2] > g.player.position.z + range) {
        positions[i + 2] -= range * 2;
        needsUpdate = true;
      }
    }

    if (needsUpdate) g.spaceDustPoints.geometry.attributes.position.needsUpdate = true;
  }
}
