import * as THREE from 'three';
import { buildVoxelSurfaceGeometry } from '../../render/voxel.js';

// Simple voxel destruction layer:
// - Each voxel object carries a mutable Set<string> of filled cells ("x,y,z" keys).
// - On hit: remove a small cluster near the impact point, spawn cube debris, and queue a geometry rebuild.
// - Rebuilds are throttled to avoid spikes (planets can be large).

function key3(x, y, z) {
  return `${x},${y},${z}`;
}

const DIRS6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];

/**
 * @param {Set<string>} filled
 */
function computeSurfaceKeys(filled) {
  const out = [];
  for (const k of filled) {
    const [xs, ys, zs] = k.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const z = Number(zs);
    let isSurface = false;
    for (const [dx, dy, dz] of DIRS6) {
      if (!filled.has(key3(x + dx, y + dy, z + dz))) {
        isSurface = true;
        break;
      }
    }
    if (isSurface) out.push(k);
  }
  return out;
}

/**
 * @param {string[]} arr
 * @param {number} count
 * @param {() => number} rng
 */
function sampleFromArray(arr, count, rng = Math.random) {
  const n = Math.min(count, arr.length);
  const a = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a.slice(0, n);
}

export class VoxelDestructionSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;

    /** @type {Set<number>} */
    this._rebuildQueue = new Set();

    // Scratch
    this._tmpW = new THREE.Vector3();
    this._tmpW2 = new THREE.Vector3();
    this._tmpL = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void dtSec;
    const g = this.game;
    if (this._rebuildQueue.size === 0) return;

    // Throttle rebuilds; keep frame time stable.
    const maxPerFrame = 3;
    let done = 0;
    for (const entityId of this._rebuildQueue) {
      this._rebuildQueue.delete(entityId);
      this._rebuildEntity(entityId, nowSec);
      done++;
      if (done >= maxPerFrame) break;
    }
  }

  /**
   * Called from CombatSystem on bullet->object collision.
   * @param {number} entityId
   * @param {THREE.Vector3} hitWorldPos
   * @param {THREE.Vector3} bulletVelWorld
   * @param {number} damage
   */
  onHit(entityId, hitWorldPos, bulletVelWorld, damage) {
    const g = this.game;
    const obj = g.renderRegistry.get(entityId);
    if (!obj) return;

    const vox = obj.userData?.voxel;
    if (!vox || !vox.filled || vox.filled.size === 0) return;

    // Convert hit point into voxel grid coordinates.
    obj.updateMatrixWorld(true);
    this._tmpW.copy(hitWorldPos);
    obj.worldToLocal(this._tmpW);

    const cellLocal = vox.voxelSizeOriginal * vox.normScale;
    if (cellLocal <= 0.000001) return;

    const cx = Math.round(this._tmpW.x / cellLocal);
    const cy = Math.round(this._tmpW.y / cellLocal);
    const cz = Math.round(this._tmpW.z / cellLocal);

    // Remove a small voxel cluster. Target count maps to HP so "fully destroyed" feels like "cubes are gone".
    const hp = g.world.getHealth(entityId);
    const maxHp = hp?.maxHp ?? 1;
    const initialCount = vox.initialCount ?? vox.filled.size;
    const voxPerHp = Math.max(0.02, initialCount / Math.max(1, maxHp));
    const targetRemove = THREE.MathUtils.clamp(Math.ceil(damage * voxPerHp), 1, 18);

    const removed = this._removeNear(vox.filled, cx, cy, cz, targetRemove);
    if (removed.length === 0) return;

    // Split removed voxels into resource vs debris.
    /** @type {string[]} */
    const removedResource = [];
    /** @type {string[]} */
    const removedDebris = [];
    for (const k of removed) {
      if (vox.resource && vox.resource.has(k)) {
        removedResource.push(k);
        vox.resource.delete(k);
      } else {
        removedDebris.push(k);
      }
    }

    // Spawn debris cubes (particles) and a few collectible resource cubes.
    if (g.spawner?.spawnVoxelImpact) {
      // Convert selected voxel keys to world positions.
      const debrisPositions = this._keysToWorldPositions(obj, vox, removedDebris);
      const resourcePositions = this._keysToWorldPositions(obj, vox, removedResource);
      g.spawner.spawnVoxelImpact({ obj, hitWorldPos, bulletVelWorld, debrisPositions, resourcePositions });
    }

    // Queue geometry rebuild (throttled).
    this._rebuildQueue.add(entityId);

    // If we visually ran out of voxels, force destruction even if HP rounding left a sliver.
    if (vox.filled.size <= 0) {
      // Satisfying final burst even when the voxel set hits 0 before HP logic.
      if (g.spawner?.spawnVoxelFinalBurst) {
        g.spawner.spawnVoxelFinalBurst({ obj, hitWorldPos, bulletVelWorld });
      }
      const h = g.world.getHealth(entityId);
      if (h) h.hp = 0;
      g.destroyObjectEntity(entityId);
    }
  }

  /**
   * @param {Set<string>} filled
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @param {number} target
   * @returns {string[]}
   */
  _removeNear(filled, cx, cy, cz, target) {
    // Search a small radius around the impact voxel; remove nearest first.
    const maxR = 4;
    /** @type {{k:string,d2:number}[]} */
    const candidates = [];
    for (let r = 0; r <= maxR; r++) {
      candidates.length = 0;
      const r2 = r * r;
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r2) continue;
            const k = key3(cx + dx, cy + dy, cz + dz);
            if (!filled.has(k)) continue;
            candidates.push({ k, d2 });
          }
        }
      }
      if (candidates.length > 0) break;
    }
    if (candidates.length === 0) return [];

    candidates.sort((a, b) => a.d2 - b.d2);
    const removed = [];
    for (let i = 0; i < candidates.length && removed.length < target; i++) {
      const k = candidates[i].k;
      if (filled.delete(k)) removed.push(k);
    }
    return removed;
  }

  /**
   * @param {THREE.Object3D} obj
   * @param {{ voxelSizeOriginal: number, normScale: number }} vox
   * @param {string[]} keys
   */
  _keysToWorldPositions(obj, vox, keys) {
    const cellLocal = vox.voxelSizeOriginal * vox.normScale;
    const out = [];
    for (const k of keys) {
      const [xs, ys, zs] = k.split(',');
      const x = Number(xs);
      const y = Number(ys);
      const z = Number(zs);
      this._tmpL.set(x * cellLocal, y * cellLocal, z * cellLocal);
      this._tmpW2.copy(this._tmpL);
      obj.localToWorld(this._tmpW2);
      out.push(this._tmpW2.clone());
    }
    return out;
  }

  _rebuildEntity(entityId, nowSec) {
    const g = this.game;
    const obj = g.renderRegistry.get(entityId);
    if (!obj || !obj.parent) return;
    const vox = obj.userData?.voxel;
    if (!vox || !vox.filled) return;

    // Avoid rebuild storms if something spams hits (planets are expensive).
    const last = vox.lastRebuildAtSec ?? -999;
    const minInterval = (vox.initialCount ?? 0) > 1800 ? 0.12 : 0.06;
    if (nowSec - last < minInterval) {
      // Re-queue; try next frame.
      this._rebuildQueue.add(entityId);
      return;
    }
    vox.lastRebuildAtSec = nowSec;

    // Planets can be huge; keep face shading stable across rebuilds.
    const geo = buildVoxelSurfaceGeometry(vox.filled, {
      voxelSize: vox.voxelSizeOriginal,
      faceShading: true,
      shadeTop: vox.shadeTop ?? 1.0,
      shadeSide: vox.shadeSide ?? 0.92,
      shadeBottom: vox.shadeBottom ?? 0.78
    });
    geo.scale(vox.normScale, vox.normScale, vox.normScale);
    geo.computeBoundingSphere();

    const old = obj.geometry;
    obj.geometry = geo;
    if (old && old.dispose) old.dispose();

    // Resource distribution changes as we carve; occasionally re-surface the resource keys so they keep popping.
    if (vox.resource && (vox._resurfaceCounter = (vox._resurfaceCounter ?? 0) + 1) % 6 === 0) {
      const surface = computeSurfaceKeys(vox.filled);
      if (surface.length > 0) {
        const want = THREE.MathUtils.clamp(Math.floor(surface.length * (vox.resourceRate ?? 0.06)), 2, 48);
        const picks = sampleFromArray(surface, want);
        for (const k of picks) vox.resource.add(k);
      }
    }
  }
}
