import * as THREE from 'three';
import { addBox, buildVoxelSurfaceGeometry } from './voxel.js';

/**
 * Creates the voxel ship model used by both the selection hangar and the game.
 *
 * @param {{
 *  shipData: any,
 *  voxelSize: number,
 *  textures: { panels: THREE.Texture, panelsDark: THREE.Texture, stripes: THREE.Texture },
 *  theme: { ship: { dark: number, accent: number, glass: number, thruster: number } },
 *  voxLit: (opts: { color: any, map?: any, emissive?: any, emissiveIntensity?: number }) => THREE.Material
 * }} opts
 */
export function createVoxelShipModel(opts) {
  const voxelSize = opts.voxelSize ?? 5;
  const mainColor = opts.shipData?.color ?? 0x44aaff;

  const group = new THREE.Group();

  // Voxel model: build separate layers so we can tint materials.
  const hull = new Set();
  const dark = new Set();
  const accent = new Set();
  const glass = new Set();
  const thruster = new Set();

  // Fuselage
  addBox(hull, -1, -1, -6, 1, 1, 6);
  addBox(hull, -2, -1, -3, 2, 1, 2);
  // Nose
  addBox(hull, -1, -1, 7, 1, 1, 10);
  addBox(accent, -1, -2, 6, 1, -2, 10);

  // Wings
  addBox(hull, -6, 0, -2, -3, 0, 4);
  addBox(hull, 3, 0, -2, 6, 0, 4);
  addBox(dark, -7, 0, -1, -6, 0, 3);
  addBox(dark, 6, 0, -1, 7, 0, 3);

  // Cockpit
  addBox(glass, -1, 2, 0, 1, 3, 3);
  addBox(dark, -1, 1, -2, 1, 1, -1);

  // Engines
  addBox(dark, -3, -1, -8, -1, 1, -6);
  addBox(dark, 1, -1, -8, 3, 1, -6);
  addBox(thruster, -2, 0, -9, -2, 0, -9);
  addBox(thruster, 2, 0, -9, 2, 0, -9);

  // Guns
  addBox(accent, -6, 0, 5, -5, 0, 7);
  addBox(accent, 5, 0, 5, 6, 0, 7);

  const hullMesh = new THREE.Mesh(
    buildVoxelSurfaceGeometry(hull, { voxelSize, faceShading: true }),
    opts.voxLit({ color: mainColor, map: opts.textures.panels, emissive: 0x0b0b12, emissiveIntensity: 0.06 })
  );
  const darkMesh = new THREE.Mesh(
    buildVoxelSurfaceGeometry(dark, { voxelSize, faceShading: true }),
    opts.voxLit({ color: opts.theme.ship.dark, map: opts.textures.panelsDark, emissive: 0x050512, emissiveIntensity: 0.1 })
  );
  const accentMesh = new THREE.Mesh(
    buildVoxelSurfaceGeometry(accent, { voxelSize, faceShading: true }),
    opts.voxLit({ color: opts.theme.ship.accent, map: opts.textures.stripes, emissive: 0x3a1b00, emissiveIntensity: 0.16 })
  );
  const glassMesh = new THREE.Mesh(
    buildVoxelSurfaceGeometry(glass, { voxelSize, faceShading: false }),
    opts.voxLit({ color: opts.theme.ship.glass, map: null, emissive: 0x00aaff, emissiveIntensity: 0.75 })
  );
  const thrusterMesh = new THREE.Mesh(
    buildVoxelSurfaceGeometry(thruster, { voxelSize, faceShading: false }),
    opts.voxLit({ color: opts.theme.ship.thruster, map: null, emissive: opts.theme.ship.thruster, emissiveIntensity: 2.2 })
  );

  group.add(hullMesh, darkMesh, accentMesh, glassMesh, thrusterMesh);

  // Center geometry around origin and lift so the ship sits on y=0.
  // NOTE: do this by translating geometries, not `group.position`, so callers can position freely.
  const box0 = new THREE.Box3().setFromObject(group);
  const center0 = box0.getCenter(new THREE.Vector3());
  const tx = -center0.x;
  const ty = -box0.min.y;
  const tz = -center0.z;
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    o.geometry.translate(tx, ty, tz);
    o.geometry.computeBoundingBox?.();
    o.geometry.computeBoundingSphere?.();
  });

  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());

  const engineOffsets = [
    new THREE.Vector3(-2, 0, -10).multiplyScalar(voxelSize).add(new THREE.Vector3(tx, ty, tz)),
    new THREE.Vector3(2, 0, -10).multiplyScalar(voxelSize).add(new THREE.Vector3(tx, ty, tz))
  ];

  // Muzzle a bit ahead of the nose.
  const muzzleOffset = new THREE.Vector3(0, size.y * 0.42, box.max.z + voxelSize * 0.6);

  return { group, engineOffsets, muzzleOffset, bounds: { size } };
}
