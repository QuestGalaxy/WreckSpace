import * as THREE from 'three';

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function hexToRgb01(hex) {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return { r, g, b };
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function rgb01ToStyle({ r, g, b }, a = 1) {
  const rr = Math.round(clamp01(r) * 255);
  const gg = Math.round(clamp01(g) * 255);
  const bb = Math.round(clamp01(b) * 255);
  return `rgba(${rr},${gg},${bb},${clamp01(a)})`;
}

/**
 * Creates a small pixel tile texture with nearest sampling.
 * Intentionally simple: Minecraft feel comes from low-res patterns + nearest filtering.
 *
 * @param {{
 *   size?: number,
 *   base: number,
 *   dark: number,
 *   light: number,
 *   kind: 'panels' | 'rock' | 'stripes'
 * }} spec
 */
export function createPixelTileTexture(spec) {
  const size = spec.size ?? 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const base = hexToRgb01(spec.base);
  const dark = hexToRgb01(spec.dark);
  const light = hexToRgb01(spec.light);

  // Fill base
  ctx.fillStyle = rgb01ToStyle(base, 1);
  ctx.fillRect(0, 0, size, size);

  if (spec.kind === 'panels') {
    // Chunky panel seams + a couple rivets.
    ctx.fillStyle = rgb01ToStyle(dark, 1);
    for (let i = 0; i < size; i += 4) {
      ctx.fillRect(i, 0, 1, size);
      ctx.fillRect(0, i, size, 1);
    }

    ctx.fillStyle = rgb01ToStyle(light, 1);
    for (let i = 0; i < 6; i++) {
      const x = (i * 5 + 3) % size;
      const y = (i * 7 + 2) % size;
      ctx.fillRect(x, y, 1, 1);
    }
  } else if (spec.kind === 'rock') {
    // Dithered noise blobs.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = Math.random();
        const c = v > 0.82 ? light : (v < 0.18 ? dark : base);
        ctx.fillStyle = rgb01ToStyle(c, 1);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // A couple cracks
    ctx.fillStyle = rgb01ToStyle(dark, 1);
    for (let i = 0; i < 10; i++) {
      const x = (i * 3 + 2) % size;
      const y = (i * 5 + 1) % size;
      ctx.fillRect(x, y, 1, 1);
    }
  } else if (spec.kind === 'stripes') {
    // Industrial warning stripes.
    for (let i = -size; i < size * 2; i += 4) {
      ctx.fillStyle = rgb01ToStyle(dark, 1);
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 2, 0);
      ctx.lineTo(i + size + 2, size);
      ctx.lineTo(i + size, size);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = rgb01ToStyle(light, 1);
    ctx.fillRect(0, 0, size, 1);
    ctx.fillRect(0, size - 1, size, 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  // Keep mipmaps but use nearest-to-nearest for less shimmer while preserving pixel feel.
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

