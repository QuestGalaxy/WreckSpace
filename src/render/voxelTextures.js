import { createPixelTileTexture } from './pixelTiles.js';

export function createVoxelTextures() {
  // Shared pixel-art tiles. We tint in materials via `color` so textures stay neutral.
  return {
    panels: createPixelTileTexture({
      kind: 'panels',
      base: 0xb9bec8,
      dark: 0x7f8796,
      light: 0xe7eaf0
    }),
    panelsDark: createPixelTileTexture({
      kind: 'panels',
      base: 0x222738,
      dark: 0x13192a,
      light: 0x3b4766
    }),
    rock: createPixelTileTexture({
      kind: 'rock',
      base: 0x8a90a1,
      dark: 0x5e6577,
      light: 0xb1b7c8
    }),
    stripes: createPixelTileTexture({
      kind: 'stripes',
      base: 0xffcc44,
      dark: 0x2a2a33,
      light: 0xffffff
    })
  };
}

