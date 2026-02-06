import * as THREE from 'three';

export class EnvironmentSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this._labelAcc = 0;
    this._tmpWorldPos = new THREE.Vector3();
    this._playerPos = new THREE.Vector3();
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
    this.updateHealthBarLayouts();
    this.updateSpaceDust();
    this.updateRetroBackdrop();
    this.updateDistanceLabels(dtSec);
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

  updateHealthBarLayouts() {
    const g = this.game;
    if (!g.objects || !g.layoutHealthBar) return;

    // Health bars are drawn when HP changes (on hit), but their screen size needs to stay stable as
    // camera distance changes. Re-layout visible bars every frame; avoid re-drawing the canvas here.
    for (const obj of g.objects) {
      const hb = obj?.userData?.healthBar;
      if (!hb?.sprite?.visible) continue;
      g.layoutHealthBar(obj);
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

    // Sparkle sprites: keep them clustered around player for readability.
    if (g.retroSparkles) {
      for (const s of g.retroSparkles) {
        const range = s.userData?.range ?? 1700;
        if (s.position.x < t.x - range) s.position.x += range * 2;
        else if (s.position.x > t.x + range) s.position.x -= range * 2;
        if (s.position.y < t.y - range) s.position.y += range * 2;
        else if (s.position.y > t.y + range) s.position.y -= range * 2;
        if (s.position.z < t.z - range) s.position.z += range * 2;
        else if (s.position.z > t.z + range) s.position.z -= range * 2;
      }
    }

    // Neon streaks: drift forward, wrap around player, and billboard to camera.
    if (g.retroStreaks) {
      for (const m of g.retroStreaks) {
        const range = m.userData?.range ?? 2400;
        const drift = m.userData?.drift ?? 0.9;
        m.position.z += drift;

        if (m.position.x < t.x - range) m.position.x += range * 2;
        else if (m.position.x > t.x + range) m.position.x -= range * 2;
        if (m.position.y < t.y - range) m.position.y += range * 2;
        else if (m.position.y > t.y + range) m.position.y -= range * 2;
        if (m.position.z < t.z - range) m.position.z += range * 2;
        else if (m.position.z > t.z + range) m.position.z -= range * 2;

        if (g.camera) {
          m.quaternion.copy(g.camera.quaternion);
          const roll = m.userData?.roll ?? 0;
          if (roll) m.rotateZ(roll);
        }
      }
    }
  }

  updateDistanceLabels(dtSec) {
    const g = this.game;
    if (!g.distanceLabelTargets || g.distanceLabelTargets.length === 0) return;
    if (!g.playerEntityId) return;

    this._labelAcc += dtSec;
    if (this._labelAcc < 0.1) return; // update labels at 10Hz
    this._labelAcc = 0;

    const pt = g.world.transform.get(g.playerEntityId);
    if (!pt) return;
    this._playerPos.set(pt.x, pt.y, pt.z);

    // Prune dead targets (destroyed planets).
    for (let i = g.distanceLabelTargets.length - 1; i >= 0; i--) {
      const entry = g.distanceLabelTargets[i];
      const target = entry.target;
      if (!target || !target.parent) {
        if (entry.sprite && g.scene) g.scene.remove(entry.sprite);
        g.distanceLabelTargets.splice(i, 1);
        continue;
      }

      target.getWorldPosition(this._tmpWorldPos);
      const distWorld = this._tmpWorldPos.distanceTo(this._playerPos);
      const distTxt = g._formatDistanceForLabel(distWorld);
      const text = `${entry.prefix}  ${distTxt}`;
      if (text !== entry.lastText) {
        entry.lastText = text;
        g._setDistanceLabelText(entry.sprite, text);
      }

      entry.sprite.position.copy(this._tmpWorldPos);
      entry.sprite.position.y += entry.yOffset;

      // Make far-away labels readable by scaling them up with distance (clamped).
      // Sprites are world-sized; without this, planet labels become tiny at large distances.
      const ws = g.worldScale ?? 1;
      const near = 600 * ws;
      const mul = THREE.MathUtils.clamp(distWorld / near, 1, 6);
      if (entry.baseScale) {
        entry.sprite.scale.set(entry.baseScale.x * mul, entry.baseScale.y * mul, entry.baseScale.z);
      }
    }
  }
}
