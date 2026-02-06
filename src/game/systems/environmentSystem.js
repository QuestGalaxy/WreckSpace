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
    this.updateRetroBackdrop();
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
    if (!g.spaceDustPoints || !g.playerEntityId) return;
    const t = g.world.transform.get(g.playerEntityId);
    if (!t) return;

    const positions = g.spaceDustPoints.geometry.attributes.position.array;
    const range = g.spaceDustPoints.userData?.range ?? 200;
    let needsUpdate = false;

    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < t.x - range) {
        positions[i] += range * 2;
        needsUpdate = true;
      } else if (positions[i] > t.x + range) {
        positions[i] -= range * 2;
        needsUpdate = true;
      }

      if (positions[i + 1] < t.y - range) {
        positions[i + 1] += range * 2;
        needsUpdate = true;
      } else if (positions[i + 1] > t.y + range) {
        positions[i + 1] -= range * 2;
        needsUpdate = true;
      }

      if (positions[i + 2] < t.z - range) {
        positions[i + 2] += range * 2;
        needsUpdate = true;
      } else if (positions[i + 2] > t.z + range) {
        positions[i + 2] -= range * 2;
        needsUpdate = true;
      }
    }

    if (needsUpdate) g.spaceDustPoints.geometry.attributes.position.needsUpdate = true;
  }

  updateRetroBackdrop() {
    const g = this.game;
    if (!g.retroBackdropLayers || !g.playerEntityId) return;
    const t = g.world.transform.get(g.playerEntityId);
    if (!t) return;

    // Wrap a few star layers around the player to maintain density without huge ranges.
    for (const layer of g.retroBackdropLayers) {
      const positions = layer.points.geometry.attributes.position.array;
      const range = layer.range;
      const speed = layer.drift;

      let needsUpdate = false;
      for (let i = 0; i < positions.length; i += 3) {
        // Slow drift in Z to feel like forward motion regardless of player input.
        positions[i + 2] += speed;

        if (positions[i] < t.x - range) {
          positions[i] += range * 2;
          needsUpdate = true;
        } else if (positions[i] > t.x + range) {
          positions[i] -= range * 2;
          needsUpdate = true;
        }

        if (positions[i + 1] < t.y - range) {
          positions[i + 1] += range * 2;
          needsUpdate = true;
        } else if (positions[i + 1] > t.y + range) {
          positions[i + 1] -= range * 2;
          needsUpdate = true;
        }

        if (positions[i + 2] < t.z - range) {
          positions[i + 2] += range * 2;
          needsUpdate = true;
        } else if (positions[i + 2] > t.z + range) {
          positions[i + 2] -= range * 2;
          needsUpdate = true;
        }
      }
      if (needsUpdate) layer.points.geometry.attributes.position.needsUpdate = true;
    }

    // Nebula sprites: keep them loosely centered so they don't disappear forever.
    if (g.retroNebulaSprites) {
      for (const s of g.retroNebulaSprites) {
        const range = s.userData?.range ?? 2200;
        if (s.position.x < t.x - range) s.position.x += range * 2;
        else if (s.position.x > t.x + range) s.position.x -= range * 2;
        if (s.position.y < t.y - range) s.position.y += range * 2;
        else if (s.position.y > t.y + range) s.position.y -= range * 2;
        if (s.position.z < t.z - range) s.position.z += range * 2;
        else if (s.position.z > t.z + range) s.position.z -= range * 2;
      }
    }
  }
}
