import * as THREE from 'three';

export class NavigationSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this._targetPos = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._dirToTarget = new THREE.Vector3();
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void dtSec;
    void nowSec;
    const g = this.game;
    if (!g.hud || !g.baseStation || !g.playerEntityId || !g.camera) return;
    const t = g.world.transform.get(g.playerEntityId);
    if (!t) return;

    const dx0 = t.x - g.baseStation.position.x;
    const dy0 = t.y - g.baseStation.position.y;
    const dz0 = t.z - g.baseStation.position.z;
    const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0);

    this._targetPos.copy(g.baseStation.position).project(g.camera);

    const widthHalf = window.innerWidth / 2;
    const heightHalf = window.innerHeight / 2;

    let x = this._targetPos.x * widthHalf + widthHalf;
    let y = -this._targetPos.y * heightHalf + heightHalf;

    g.camera.getWorldDirection(this._camDir);
    this._dirToTarget.subVectors(g.baseStation.position, g.camera.position).normalize();
    const dot = this._camDir.dot(this._dirToTarget);

    const isOffScreen =
      x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight || dot < 0.2;

    let angle = 0;
    if (isOffScreen) {
      let dx = x - widthHalf;
      let dy = y - heightHalf;

      if (dot < 0) {
        dx = -dx;
        dy = -dy;
      }

      const length = Math.sqrt(dx * dx + dy * dy);
      if (length > 0) {
        dx /= length;
        dy /= length;
      }

      const padding = 40;
      const edgeX = widthHalf - padding;
      const edgeY = heightHalf - padding;

      let t = Infinity;
      if (dx !== 0) {
        const tx = (dx > 0 ? edgeX : -edgeX) / dx;
        if (tx > 0) t = Math.min(t, tx);
      }
      if (dy !== 0) {
        const ty = (dy > 0 ? edgeY : -edgeY) / dy;
        if (ty > 0) t = Math.min(t, ty);
      }

      x = widthHalf + dx * t;
      y = heightHalf + dy * t;
      angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
    }

    g.hud.setBaseMarker({ x, y, angleDeg: angle, distM: dist, offScreen: isOffScreen });
  }
}
