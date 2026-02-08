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
    this._tmpQ = new THREE.Quaternion();
    this._tmpQInv = new THREE.Quaternion();
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

    const fx = this._tmpW.x / cellLocal;
    const fy = this._tmpW.y / cellLocal;
    const fz = this._tmpW.z / cellLocal;

    const anchor = this._findAnchorVoxel(vox.filled, fx, fy, fz);
    if (!anchor) return;
    const { cx, cy, cz } = anchor;

    // Remove a small voxel cluster. Target count maps to HP so "fully destroyed" feels like "cubes are gone".
    const hp = g.world.getHealth(entityId);
    const maxHp = hp?.maxHp ?? 1;
    const initialCount = vox.initialCount ?? vox.filled.size;
    const voxPerHp = Math.max(0.02, initialCount / Math.max(1, maxHp));
    const cinematic = (g?.hitFeedbackProfile ?? (g?.mode === 'testArea' ? 'cinematic' : 'subtle')) === 'cinematic';
    const isPlanet = obj?.userData?.type === 'planet';
    // Cinematic: more satisfying chunk spray per hit (visual polish over long-term progression).
    const mul = cinematic ? (isPlanet ? 1.55 : 1.35) : 1.0;
    const cap = cinematic ? (isPlanet ? 36 : 24) : 18;
    const targetRemove = THREE.MathUtils.clamp(Math.ceil((damage ?? 0) * voxPerHp * mul), 1, cap);

    const removed = this._removeNear(vox.filled, cx, cy, cz, targetRemove);
    if (removed.length === 0) return;

    // Carve a bit deeper along the shot direction to make a more readable crater.
    // Cinematic is more aggressive; subtle preserves pacing.
    if (isPlanet && bulletVelWorld) {
      // Convert bullet direction to object-local space.
      obj.getWorldQuaternion(this._tmpQ);
      this._tmpQInv.copy(this._tmpQ).invert();
      this._tmpDir.copy(bulletVelWorld).normalize().applyQuaternion(this._tmpQInv);

      const dmg = Math.max(0, damage ?? 0);
      const feel = cinematic ? 1.0 : 0.45;
      const steps = THREE.MathUtils.clamp(Math.floor((1 + dmg / 14) * feel) + 1, cinematic ? 2 : 1, cinematic ? 6 : 3);
      const perStep = THREE.MathUtils.clamp(Math.floor((2 + dmg * 0.07) * feel) + 1, cinematic ? 2 : 1, cinematic ? 7 : 4);
      for (let s = 1; s <= steps; s++) {
        // Move inward along the shot direction.
        this._tmpL.copy(this._tmpW).addScaledVector(this._tmpDir, s * cellLocal * 0.9);
        const f2x = this._tmpL.x / cellLocal;
        const f2y = this._tmpL.y / cellLocal;
        const f2z = this._tmpL.z / cellLocal;
        const a2 = this._findAnchorVoxel(vox.filled, f2x, f2y, f2z);
        if (!a2) continue;
        const r2 = this._removeNear(vox.filled, a2.cx, a2.cy, a2.cz, perStep);
        if (r2.length > 0) removed.push(...r2);
      }
    }

    // Global chip so the whole planet "reacts" to the impact.
    // In subtle, keep this small; in cinematic, let it rip.
    if (isPlanet) {
      const dmg = Math.max(0, damage ?? 0);
      const feel = cinematic ? 1.0 : 0.35;
      const extra = THREE.MathUtils.clamp(Math.floor((8 + dmg * 0.35) * feel), cinematic ? 12 : 2, cinematic ? 40 : 10);
      if (extra > 0) {
        const gkeys = this._removeGlobalSurface(vox.filled, extra);
        if (gkeys.length > 0) removed.push(...gkeys);
      }
    }

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
   * Remove a small random sample of surface voxels across the whole body.
   * @param {Set<string>} filled
   * @param {number} count
   * @returns {string[]}
   */
  _removeGlobalSurface(filled, count) {
    const surface = computeSurfaceKeys(filled);
    if (surface.length === 0) return [];

    const want = Math.min(Math.max(0, count | 0), surface.length);
    if (want <= 0) return [];

    const picks = sampleFromArray(surface, want, Math.random);
    const out = [];
    for (const k of picks) {
      if (filled.delete(k)) out.push(k);
    }
    return out;
  }

  /**
   * Picks the voxel cell that should "take the hit".
   * Goal: if the hit is on the surface, we want the nearest filled voxel at that surface point,
   * not an arbitrary neighbor due to rounding.
   *
   * @param {Set<string>} filled
   * @param {number} fx hit position in voxel-grid units
   * @param {number} fy hit position in voxel-grid units
   * @param {number} fz hit position in voxel-grid units
   * @returns {{cx:number,cy:number,cz:number} | null}
   */
  _findAnchorVoxel(filled, fx, fy, fz) {
    // 1) Direct check.
    let cx = Math.round(fx);
    let cy = Math.round(fy);
    let cz = Math.round(fz);
    if (filled.has(key3(cx, cy, cz))) return { cx, cy, cz };

    // 2) Nearest filled voxel in a small neighborhood, scored by distance to the *float* hit position.
    const maxR = 5;
    /** @type {{cx:number,cy:number,cz:number,d2:number} | null} */
    let best = null;
    for (let r = 1; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const ix = cx + dx;
            const iy = cy + dy;
            const iz = cz + dz;
            if (!filled.has(key3(ix, iy, iz))) continue;
            const ddx = ix - fx;
            const ddy = iy - fy;
            const ddz = iz - fz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (!best || d2 < best.d2) best = { cx: ix, cy: iy, cz: iz, d2 };
          }
        }
      }
      if (best) return { cx: best.cx, cy: best.cy, cz: best.cz };
    }

    // 3) Ray search toward the center (and slightly outward) for hollow shells: snap to the first filled cell.
    // If we hit near a hole edge, the closest point can land just outside a filled voxel.
    const len = Math.hypot(fx, fy, fz);
    const inv = len > 0.000001 ? 1 / len : 0;
    const dx = -fx * inv;
    const dy = -fy * inv;
    const dz = -fz * inv;
    const step = 0.75;
    const steps = 20;

    for (let s = 0; s <= steps; s++) {
      const t = s * step;
      const ix = Math.round(fx + dx * t);
      const iy = Math.round(fy + dy * t);
      const iz = Math.round(fz + dz * t);
      if (filled.has(key3(ix, iy, iz))) return { cx: ix, cy: iy, cz: iz };
    }
    for (let s = 1; s <= 10; s++) {
      const t = s * step;
      const ix = Math.round(fx - dx * t);
      const iy = Math.round(fy - dy * t);
      const iz = Math.round(fz - dz * t);
      if (filled.has(key3(ix, iy, iz))) return { cx: ix, cy: iy, cz: iz };
    }

    return null;
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
      shadeBottom: vox.shadeBottom ?? 0.78,
      uvMode: vox.uvMode ?? 'perFace',
      uvScale: vox.uvScale ?? 1.0
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
