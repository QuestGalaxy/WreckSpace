import * as THREE from 'three';

/**
 * Creates a tiny toon ramp texture for MeshToonMaterial.
 * Nearest filtering keeps the banding crisp (retro/toon look).
 */
export function createToonGradientMap() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');

  // 4-step ramp from dark -> light. Keep it a bit lifted so nothing goes pitch black.
  const steps = ['#2a2a35', '#4a4a62', '#7f7fa3', '#e6e6ff'];
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = steps[i];
    ctx.fillRect(i, 0, 1, 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

