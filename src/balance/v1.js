// V1 balance: single source of truth for ship/weapon/progression/loot.
// Keep this file minimal and data-driven; game systems should not hardcode numbers elsewhere.

export const V1 = Object.freeze({
  currencyUnits: Object.freeze({
    coinPickup: 10,
    gemPickup: 50
  }),

  ships: Object.freeze({
    scout: Object.freeze({
      id: 'scout',
      name: 'Scout',
      speed: 1.2,
      hull: 100,
      cargo: 30,
      warpCooldownSec: 10,
      color: 0x00ffcc,
      description: 'Fast and agile, but limited cargo.'
    }),
    balanced: Object.freeze({
      id: 'balanced',
      name: 'Balanced',
      speed: 1.0,
      hull: 120,
      cargo: 50,
      warpCooldownSec: 12,
      color: 0xff3333,
      description: 'Balanced all-rounder for deeper runs.'
    }),
    miner: Object.freeze({
      id: 'miner',
      name: 'Miner',
      speed: 0.7,
      hull: 150,
      cargo: 100,
      warpCooldownSec: 14,
      color: 0xffcc00,
      description: 'Slow, tough, and built for big hauls.'
    })
  }),

  shipUpgrades: Object.freeze({
    maxTier: 3,
    // Each tier is purchased with Coin.
    speed: Object.freeze({
      // Multiply base speed by (1 + tier*deltaMul)
      deltaMul: 0.10,
      costs: Object.freeze([60, 120, 200])
    }),
    hull: Object.freeze({
      // Add to base hull
      deltaFlat: 25,
      costs: Object.freeze([80, 160, 260])
    }),
    cargo: Object.freeze({
      deltaFlat: 10,
      costs: Object.freeze([70, 140, 230])
    }),
    warp: Object.freeze({
      // Reduce cooldown by tier*deltaSec (clamped at minCooldownSec)
      deltaSec: 1,
      minCooldownSec: 6,
      costs: Object.freeze([90, 180, 300])
    })
  }),

  weapon: Object.freeze({
    baseDamage: 10,
    baseFireRateMs: 600
  }),

  weaponUpgrades: Object.freeze({
    maxTier: 3,
    damage: Object.freeze({
      deltaFlat: 2,
      costs: Object.freeze([60, 120, 200])
    }),
    fireRate: Object.freeze({
      // Reduce ms by tier*deltaMs (clamped at minFireRateMs)
      deltaMs: 60,
      minFireRateMs: 360,
      costs: Object.freeze([60, 120, 200])
    })
  }),

  weaponLevels: Object.freeze({
    // Crafted with Gem; not upgraded directly with Coin.
    tiers: Object.freeze({
      1: Object.freeze({ tier: 1, gemCost: 0, damageMultiplier: 1.0 }),
      2: Object.freeze({ tier: 2, gemCost: 150, damageMultiplier: 1.25 }),
      3: Object.freeze({ tier: 3, gemCost: 300, damageMultiplier: 1.6 })
    })
  }),

  addons: Object.freeze({
    slots: 3,
    magnet: Object.freeze({
      id: 'magnet',
      name: 'Magnet',
      gemCost: 100,
      baseRange: 90, // world units before worldScale
      rangePerExtraStack: 45
    }),
    shield: Object.freeze({
      id: 'shield',
      name: 'Shield',
      gemCost: 120,
      maxPerStack: 60,
      regenPerStackPerSec: 6
    })
  }),

  powerups: Object.freeze({
    // Powerups are instant pickups with temporary effects; no inventory.
    megaMagnet: Object.freeze({ id: 'megaMagnet', name: 'Mega Magnet', durationSec: 14, magnetRangeMultiplier: 3.0 }),
    damageBoost: Object.freeze({ id: 'damageBoost', name: 'Damage Boost', durationSec: 12, damageMultiplier: 1.6 }),
    overdrive: Object.freeze({ id: 'overdrive', name: 'Overdrive', durationSec: 10, speedMultiplier: 1.5, fireRateMultiplier: 0.75 }),
    instantShield: Object.freeze({ id: 'instantShield', name: 'Instant Shield', durationSec: 8, bonusShieldMax: 80 }),
    freeWarp: Object.freeze({ id: 'freeWarp', name: 'Free Warp', durationSec: 0 })
  }),

  targets: Object.freeze({
    // Planets only (for now): 3 sizes.
    // HP roughly maps to "shots to destroy" given baseDamage=10:
    // - small ~14 shots, medium ~32 shots, large ~65 shots (before upgrades).
    planet_small: Object.freeze({
      kind: 'planet_small',
      type: 'planet',
      hp: 50,
      drops: Object.freeze({ coin: 60, gem: 60 }),
      powerupDropChance: 0.10,
      // Multiplies explosion visuals/audio intensity (in addition to scale).
      explosionMul: 0.95
    }),
    planet_medium: Object.freeze({
      kind: 'planet_medium',
      type: 'planet',
      hp: 120,
      drops: Object.freeze({ coin: 140, gem: 160 }),
      powerupDropChance: 0.16,
      explosionMul: 1.00
    }),
    planet_large: Object.freeze({
      kind: 'planet_large',
      type: 'planet',
      hp: 350,
      drops: Object.freeze({ coin: 260, gem: 320 }),
      powerupDropChance: 0.22,
      explosionMul: 1.18
    })
  }),

  collisionDamage: Object.freeze({
    // V1: Ship damage should come from enemy fire, not collisions.
    enabled: false,
    // Damage per second while overlapping.
    dpsByKind: Object.freeze({
      planet_small: 26,
      planet_medium: 32,
      planet_large: 40
    })
  }),

  spawn: Object.freeze({
    // AABB half-range (multiplied by worldScale).
    // NOTE: planet scales are huge (medium/large). Keep the world range large enough so
    // minimum separation constraints can be satisfied without clumping near the origin/base.
    planetRange: 12000,
    planets: Object.freeze({
      small: 15,
      medium: 7,
      large: 4
    })
  })
});

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function clampInt(x, a, b) {
  return Math.max(a, Math.min(b, Math.floor(x)));
}
