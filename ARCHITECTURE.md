# Architecture

This project started as a single-file Three.js prototype and is being refactored into a long-lived codebase.
The refactor is incremental: gameplay "truth" is moving from Three.js objects into a simulation layer (`World`),
while Three.js becomes a render shell that syncs from simulation state.

## Key Concepts

### World (Simulation State)

`src/game/world/world.js`

`World` is the source of truth for gameplay data. It's intentionally minimal right now and will evolve into
component maps (ECS-like), but without forcing a full ECS rewrite.

Current components:
- `objectMeta`: entityId -> `{ type, lootValue }` (asteroids/planets)
- `health`: entityId -> `{ hp, maxHp }`
- `loot`: entityId -> `{ type, value }`
- `transform`: entityId -> `{ x,y,z, rx,ry,rz, sx,sy,sz }`
- `velocity`: entityId -> `{ x,y,z }` (loot + player)
- `rotationQuat`: entityId -> `{ x,y,z,w }` (player)
- `lootMotion`: entityId -> `{ rotationSpeed, driftOffset, floatBaseY }`
- `spin`: entityId -> `{ x,y,z }` (asteroids/planets angular velocity)

### Render Registry (Entity <-> Object3D Binding)

`src/render/syncFromWorld.js`

`RenderRegistry` maps `entityId -> Object3D` and also stamps `obj3d.userData.entityId`.
This is the bridge while we migrate systems to world-first.

## Systems

All gameplay logic is under:

`src/game/systems/`

Important files:
- `movementSystem.js`: updates player movement in `World` (position/velocity/quaternion), then syncs the player mesh
- `cameraSystem.js`: camera follows the player's world state (position/quaternion)
- `combatSystem.js`: world-first targeting + bullet collision against `World.transform`/`World.health`
- `lootSystem.js`: world-first loot movement + magnet + collection, with mesh sync via `RenderRegistry`
- `environmentSystem.js`: updates asteroid/planet spin in `World`, then syncs meshes; also space dust wrap
- `navigationSystem.js`: base marker UI driven by world player position + camera projection
- `vfxSystem.js`: VFX simulation + pooling (engine trails, smoke, sparks, fireballs, hit sparks)
- `spawnSystem.js`: spawns loot + fragments (with pooling); seeds world state for loot entities

## Frame Update Order

Defined in:

`src/game.js`

Order matters because systems depend on each other:
1. `MovementSystem`: update player world transform/quaternion
2. `EnvironmentSystem`: update + sync world objects (so other systems see fresh world transforms)
3. `CameraSystem`: follow player
4. `CombatSystem`: targeting + bullet update/collision
5. `NavigationSystem`: base marker projection from camera
6. `VfxSystem`: VFX simulation
7. `LootSystem`: loot sim + sync + collect/deposit checks

The game loop uses a fixed timestep runner for stable simulation behavior.

## Migration Status / Known Transitional Areas

- Bullets are still simulated as Three.js meshes (position/velocity stored on `bullet.userData`).
  Collision is world-first, but "bullet truth" is still mesh-first. Next step would be `World.bullets`.
- Asteroids/planets are kept in `game.objects` array for some legacy flows (destroy-by-index); the long-term goal
  is to derive iteration from `World.objectMeta` + `RenderRegistry` only.
- Some `mesh.userData` fields remain render-only (healthbar sprite handles, loot ring/glow references).
