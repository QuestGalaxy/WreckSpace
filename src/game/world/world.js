/**
 * Minimal world state container (simulation data).
 * Goal: progressively move "truth" from Three.js meshes into this layer.
 */
export class World {
  constructor() {
    /** @type {number} */
    this._nextId = 1;

    /** @type {Set<number>} */
    this.entities = new Set();

    /** @type {Map<number, { type: string, lootValue: number }>} */
    this.objectMeta = new Map();

    /** @type {Map<number, { hp: number, maxHp: number }>} */
    this.health = new Map();

    /** @type {Map<number, { type: string, value: number }>} */
    this.loot = new Map();

    /**
     * Generic transform storage (used by loot first, then gradually by everything).
     * Units are world units; rotation is radians.
     * @type {Map<number, { x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number }>}
     */
    this.transform = new Map();

    /** @type {Map<number, { x: number, y: number, z: number }>} */
    this.velocity = new Map();

    /**
     * Loot-only motion params (temporary; becomes a component later).
     * @type {Map<number, { rotationSpeed: { x: number, y: number, z: number }, driftOffset: number, floatBaseY: number }>}
     */
    this.lootMotion = new Map();

    /**
     * Generic spin / angular velocity (used by asteroids/planets first).
     * @type {Map<number, { x: number, y: number, z: number }>}
     */
    this.spin = new Map();
  }

  /** @returns {number} */
  createEntity() {
    const id = this._nextId++;
    this.entities.add(id);
    return id;
  }

  /**
   * @param {{ type: string, hp: number, maxHp: number, lootValue: number }} meta
   * @returns {number} entityId
   */
  createObject(meta) {
    const id = this.createEntity();
    this.objectMeta.set(id, { type: meta.type, lootValue: meta.lootValue });
    this.health.set(id, { hp: meta.hp, maxHp: meta.maxHp });
    return id;
  }

  /**
   * @param {{ type: string, value: number }} meta
   * @returns {number} entityId
   */
  createLoot(meta) {
    const id = this.createEntity();
    this.loot.set(id, { type: meta.type, value: meta.value });
    return id;
  }

  /**
   * @param {number} entityId
   */
  removeEntity(entityId) {
    this.entities.delete(entityId);
    this.objectMeta.delete(entityId);
    this.health.delete(entityId);
    this.loot.delete(entityId);
    this.transform.delete(entityId);
    this.velocity.delete(entityId);
    this.lootMotion.delete(entityId);
    this.spin.delete(entityId);
  }

  /**
   * @param {number} entityId
   * @returns {{ hp: number, maxHp: number } | null}
   */
  getHealth(entityId) {
    return this.health.get(entityId) ?? null;
  }

  /**
   * @param {number} entityId
   * @param {number} amount
   * @returns {{ hp: number, maxHp: number } | null}
   */
  damage(entityId, amount) {
    const h = this.health.get(entityId);
    if (!h) return null;
    h.hp = Math.max(0, h.hp - amount);
    return h;
  }
}
