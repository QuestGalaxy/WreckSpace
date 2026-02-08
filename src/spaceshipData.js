import { V1 } from './balance/v1.js';

// V1 ships: exactly 4 stats (Speed, Hull, Cargo, Warp cooldown).
// Keep this export stable; hangar UI and Game constructor consume it.
export const spaceships = [V1.ships.scout, V1.ships.balanced, V1.ships.miner];
