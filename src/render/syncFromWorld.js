/**
 * Render-side registry for mapping world entities <-> Three.js objects.
 * For now we mostly use `mesh.userData.entityId`, but this becomes useful once
 * transforms and other sim state move into `World`.
 */
export class RenderRegistry {
  constructor() {
    /** @type {Map<number, any>} */
    this.entityToObject3D = new Map();
  }

  /**
   * @param {number} entityId
   * @param {any} obj3d
   */
  bind(entityId, obj3d) {
    this.entityToObject3D.set(entityId, obj3d);
    if (obj3d && obj3d.userData) obj3d.userData.entityId = entityId;
  }

  /**
   * @param {number} entityId
   */
  unbind(entityId) {
    const obj = this.entityToObject3D.get(entityId);
    if (obj && obj.userData) delete obj.userData.entityId;
    this.entityToObject3D.delete(entityId);
  }

  /**
   * @param {number} entityId
   */
  get(entityId) {
    return this.entityToObject3D.get(entityId) ?? null;
  }
}

