// Retro CRT / pixel / palette quantization shader for Three.js post-processing.
// Intentionally stylized: scanlines, subtle vignette, chromatic offset, pixelation, ordered dithering.

import * as THREE from 'three';

export const RetroCrtShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) }, // in physical pixels
    uTime: { value: 0 },
    uPixelSize: { value: 2.0 }, // >=1: larger = chunkier pixels
    uScanline: { value: 0.35 }, // 0..1
    uVignette: { value: 0.35 }, // 0..1
    uCurvature: { value: 0.08 }, // 0..0.2
    uChroma: { value: 0.9 }, // 0..2 (in pixels-ish)
    uNoise: { value: 0.06 }, // 0..0.2
    uMask: { value: 0.55 }, // 0..1 CRT shadow mask strength
    uLevels: { value: 32.0 }, // palette levels per channel
    uDither: { value: 0.85 }, // 0..1
    uContrast: { value: 1.05 }, // 0.8..1.3
    uBrightness: { value: 1.05 } // 0.8..1.3
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uPixelSize;
    uniform float uScanline;
    uniform float uVignette;
    uniform float uCurvature;
    uniform float uChroma;
    uniform float uNoise;
    uniform float uMask;
    uniform float uLevels;
    uniform float uDither;
    uniform float uContrast;
    uniform float uBrightness;

    float hash12(vec2 p) {
      // Small, cheap hash for film grain.
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float bayer4x4(vec2 p) {
      // 4x4 Bayer matrix threshold in [0,1).
      //  0  8  2 10
      // 12  4 14  6
      //  3 11  1  9
      // 15  7 13  5
      float x = mod(p.x, 4.0);
      float y = mod(p.y, 4.0);
      float v = 0.0;
      if (y < 1.0) {
        v = (x < 1.0) ? 0.0 : (x < 2.0) ? 8.0 : (x < 3.0) ? 2.0 : 10.0;
      } else if (y < 2.0) {
        v = (x < 1.0) ? 12.0 : (x < 2.0) ? 4.0 : (x < 3.0) ? 14.0 : 6.0;
      } else if (y < 3.0) {
        v = (x < 1.0) ? 3.0 : (x < 2.0) ? 11.0 : (x < 3.0) ? 1.0 : 9.0;
      } else {
        v = (x < 1.0) ? 15.0 : (x < 2.0) ? 7.0 : (x < 3.0) ? 13.0 : 5.0;
      }
      return (v + 0.5) / 16.0;
    }

    vec2 crtWarp(vec2 uv, float amt) {
      // Subtle barrel distortion.
      vec2 p = uv * 2.0 - 1.0;
      vec2 p2 = p * p;
      p += p * (p2.yx) * amt;
      return (p * 0.5 + 0.5);
    }

    void main() {
      vec2 uv = vUv;

      // CRT curvature
      uv = crtWarp(uv, uCurvature);
      // Slight horizontal wobble (very small, but visible with scanlines)
      float wobble = sin((uv.y + uTime * 0.55) * 16.0) * 0.0008;
      uv.x += wobble;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      // Pixelation grid (in physical pixels)
      float px = max(1.0, uPixelSize);
      vec2 grid = uResolution / px;
      vec2 uvPix = floor(uv * grid) / grid;

      // Chromatic offset along radial direction
      vec2 c = uvPix - 0.5;
      float dist = length(c);
      vec2 dir = (dist > 1e-5) ? (c / dist) : vec2(0.0);
      vec2 o = dir * (uChroma / uResolution);

      vec3 col;
      col.r = texture2D(tDiffuse, uvPix + o).r;
      col.g = texture2D(tDiffuse, uvPix).g;
      col.b = texture2D(tDiffuse, uvPix - o).b;

      // Gentle contrast/brightness to keep blacks from crushing.
      col = (col - 0.5) * uContrast + 0.5;
      col *= uBrightness;

      // Scanlines: every other row slightly darker.
      float row = floor(uv * uResolution).y;
      float scan = mod(row, 2.0);
      float scanMul = mix(1.0, 0.80, uScanline * scan);
      col *= scanMul;

      // Ordered dithering + palette quantization
      vec2 pxy = floor(uv * uResolution);
      float b = bayer4x4(pxy) - 0.5;
      vec3 d = vec3(b) * (uDither / uLevels);
      col = floor((col + d) * (uLevels - 1.0) + 0.5) / (uLevels - 1.0);

      // Shadow mask (RGB triads) to sell CRT. Works best after quantization.
      float triad = mod(pxy.x, 3.0);
      vec3 mask = (triad < 1.0) ? vec3(1.10, 0.90, 0.90) : (triad < 2.0) ? vec3(0.90, 1.10, 0.90) : vec3(0.90, 0.90, 1.10);
      col *= mix(vec3(1.0), mask, uMask);

      // Film grain/noise (stable-ish per pixel)
      float n = hash12(pxy + floor(uTime * 60.0)) - 0.5;
      col += n * uNoise;

      // Vignette
      float vig = smoothstep(0.92, 0.25, dist);
      col *= mix(1.0, vig, uVignette);

      gl_FragColor = vec4(col, 1.0);
    }
  `
};
