import * as THREE from 'three';

function key3(x, y, z) {
  return `${x},${y},${z}`;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Adds an axis-aligned integer box (inclusive ranges) into a voxel set.
 * @param {Set<string>} set
 * @param {number} x0
 * @param {number} y0
 * @param {number} z0
 * @param {number} x1
 * @param {number} y1
 * @param {number} z1
 */
export function addBox(set, x0, y0, z0, x1, y1, z1) {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  for (let z = minZ; z <= maxZ; z++) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        set.add(key3(x, y, z));
      }
    }
  }
}

/**
 * Adds a sphere-ish blob to a voxel set.
 * @param {Set<string>} set
 * @param {number} radius
 * @param {{hollow?: boolean, thickness?: number, jitter?: number, rng?: () => number}} [opts]
 */
export function addSphere(set, radius, opts = {}) {
  const hollow = !!opts.hollow;
  const thickness = Math.max(1, Math.floor(opts.thickness ?? 1));
  const jitter = Math.max(0, opts.jitter ?? 0);
  const rng = opts.rng ?? Math.random;

  const r = Math.max(1, Math.floor(radius));
  const rOuter = r + jitter;
  const rInner = Math.max(0, r - thickness);

  for (let z = -r - 1; z <= r + 1; z++) {
    for (let y = -r - 1; y <= r + 1; y++) {
      for (let x = -r - 1; x <= r + 1; x++) {
        const d = Math.sqrt(x * x + y * y + z * z);
        const noisyOuter = rOuter + (rng() - 0.5) * jitter;
        if (d > noisyOuter) continue;
        if (hollow && d < rInner) continue;
        set.add(key3(x, y, z));
      }
    }
  }
}

/**
 * Builds a surface-only voxel mesh: faces between filled<->empty cells become quads.
 * This is dramatically cheaper than merging BoxGeometry per cell (which keeps interior faces).
 *
 * @param {Set<string>} filled
 * @param {{
 *   voxelSize?: number,
 *   faceShading?: boolean,
 *   shadeTop?: number,
 *   shadeSide?: number,
 *   shadeBottom?: number
 * }} [opts]
 */
export function buildVoxelSurfaceGeometry(filled, opts = {}) {
  const voxelSize = opts.voxelSize ?? 1;
  const hs = voxelSize * 0.5;
  const faceShading = opts.faceShading ?? true;
  const shadeTop = opts.shadeTop ?? 1.0;
  const shadeSide = opts.shadeSide ?? 0.82;
  const shadeBottom = opts.shadeBottom ?? 0.65;

  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const normals = [];
  /** @type {number[]} */
  const uvs = [];
  /** @type {number[]} */
  const colors = [];

  const pushFace = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz) => {
    // 2 triangles: a-b-c, a-c-d
    positions.push(
      ax, ay, az, bx, by, bz, cx, cy, cz,
      ax, ay, az, cx, cy, cz, dx, dy, dz
    );
    for (let i = 0; i < 6; i++) normals.push(nx, ny, nz);

    // Simple 0..1 UV per voxel face. Each voxel face maps the full tile.
    // a(0,0) b(0,1) c(1,1) d(1,0)
    uvs.push(
      0, 0, 0, 1, 1, 1,
      0, 0, 1, 1, 1, 0
    );

    const shade = faceShading ? (ny === 1 ? shadeTop : (ny === -1 ? shadeBottom : shadeSide)) : 1.0;
    for (let i = 0; i < 6; i++) colors.push(shade, shade, shade);
  };

  const dirs = [
    { dx: 1, dy: 0, dz: 0, nx: 1, ny: 0, nz: 0, face: 'px' },
    { dx: -1, dy: 0, dz: 0, nx: -1, ny: 0, nz: 0, face: 'nx' },
    { dx: 0, dy: 1, dz: 0, nx: 0, ny: 1, nz: 0, face: 'py' },
    { dx: 0, dy: -1, dz: 0, nx: 0, ny: -1, nz: 0, face: 'ny' },
    { dx: 0, dy: 0, dz: 1, nx: 0, ny: 0, nz: 1, face: 'pz' },
    { dx: 0, dy: 0, dz: -1, nx: 0, ny: 0, nz: -1, face: 'nz' }
  ];

  for (const k of filled) {
    const parts = k.split(',');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);

    const cx = x * voxelSize;
    const cy = y * voxelSize;
    const cz = z * voxelSize;

    for (const d of dirs) {
      const nk = key3(x + d.dx, y + d.dy, z + d.dz);
      if (filled.has(nk)) continue; // interior face, skip

      // Build quad corners per face.
      if (d.face === 'px') {
        pushFace(
          cx + hs, cy - hs, cz - hs,
          cx + hs, cy + hs, cz - hs,
          cx + hs, cy + hs, cz + hs,
          cx + hs, cy - hs, cz + hs,
          d.nx, d.ny, d.nz
        );
      } else if (d.face === 'nx') {
        pushFace(
          cx - hs, cy - hs, cz + hs,
          cx - hs, cy + hs, cz + hs,
          cx - hs, cy + hs, cz - hs,
          cx - hs, cy - hs, cz - hs,
          d.nx, d.ny, d.nz
        );
      } else if (d.face === 'py') {
        pushFace(
          cx - hs, cy + hs, cz - hs,
          cx - hs, cy + hs, cz + hs,
          cx + hs, cy + hs, cz + hs,
          cx + hs, cy + hs, cz - hs,
          d.nx, d.ny, d.nz
        );
      } else if (d.face === 'ny') {
        pushFace(
          cx - hs, cy - hs, cz + hs,
          cx - hs, cy - hs, cz - hs,
          cx + hs, cy - hs, cz - hs,
          cx + hs, cy - hs, cz + hs,
          d.nx, d.ny, d.nz
        );
      } else if (d.face === 'pz') {
        pushFace(
          cx - hs, cy - hs, cz + hs,
          cx + hs, cy - hs, cz + hs,
          cx + hs, cy + hs, cz + hs,
          cx - hs, cy + hs, cz + hs,
          d.nx, d.ny, d.nz
        );
      } else if (d.face === 'nz') {
        pushFace(
          cx + hs, cy - hs, cz - hs,
          cx - hs, cy - hs, cz - hs,
          cx - hs, cy + hs, cz - hs,
          cx + hs, cy + hs, cz - hs,
          d.nx, d.ny, d.nz
        );
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeBoundingSphere();
  return geo;
}
