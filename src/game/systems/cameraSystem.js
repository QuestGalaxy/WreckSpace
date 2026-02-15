import * as THREE from 'three';

export class CameraSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this._idealOffset = new THREE.Vector3();
    this._worldOffset = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._playerUp = new THREE.Vector3();
    this._playerPos = new THREE.Vector3();
    this._playerQuat = new THREE.Quaternion();
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void nowSec;
    const g = this.game;
    if (!g.playerEntityId || !g.camera) return;
    const keyDown = (code) => (typeof g.isControlActive === 'function' ? g.isControlActive(code) : !!g.keys?.[code]);
    const t = g.world.transform.get(g.playerEntityId);
    const rq = g.world.rotationQuat.get(g.playerEntityId);
    if (!t || !rq) return;

    const k = dtSec * 60;
    const cfg = g.cameraConfig ?? {};
    const followBase = typeof cfg.follow === 'number' ? cfg.follow : 0.08;
    const upBase = typeof cfg.upLerp === 'number' ? cfg.upLerp : 0.1;
    const fovBase = typeof cfg.fovLerp === 'number' ? cfg.fovLerp : 0.04;
    const follow = 1 - Math.pow(1 - followBase, k);
    const upLerp = 1 - Math.pow(1 - upBase, k);
    const fovLerp = 1 - Math.pow(1 - fovBase, k);

    // Camera sits behind+above the ship. Keep it ship-relative so controls/aiming feel consistent.
    const ws = g.worldScale ?? 1;
    const camScale = Math.pow(ws, 0.75);
    const distScale = 1.75;
    const baseOffsetZ = typeof cfg.offsetZ === 'number' ? cfg.offsetZ : -30;
    const baseOffsetY = typeof cfg.offsetY === 'number' ? cfg.offsetY : 22;
    const boostOffsetZ = typeof cfg.boostOffsetZ === 'number' ? cfg.boostOffsetZ : -36;
    const boostOffsetY = typeof cfg.boostOffsetY === 'number' ? cfg.boostOffsetY : 20;
    const offsetZ = (keyDown('KeyZ') ? boostOffsetZ : baseOffsetZ) * camScale * distScale;
    const offsetY = (keyDown('KeyZ') ? boostOffsetY : baseOffsetY) * camScale;

    this._idealOffset.set(0, offsetY, offsetZ);

    if (keyDown('KeyZ') || g.cameraShake > 0) {
      const shakeAmt = keyDown('KeyZ') ? 0.2 : g.cameraShake;
      this._idealOffset.x += (Math.random() - 0.5) * shakeAmt;
      this._idealOffset.y += (Math.random() - 0.5) * shakeAmt;
      if (g.cameraShake > 0) g.cameraShake *= Math.pow(0.9, k);
    }

    this._playerPos.set(t.x, t.y, t.z);
    this._playerQuat.set(rq.x, rq.y, rq.z, rq.w);

    this._worldOffset.copy(this._idealOffset).applyQuaternion(this._playerQuat).add(this._playerPos);
    g.camera.position.lerp(this._worldOffset, follow);

    // Look ahead a bit, but keep it in ship-local space.
    const lookY = (typeof cfg.lookY === 'number' ? cfg.lookY : 6) * camScale;
    const lookZ = (typeof cfg.lookZ === 'number' ? cfg.lookZ : 90) * camScale;
    this._lookTarget.set(0, lookY, lookZ).applyQuaternion(this._playerQuat).add(this._playerPos);
    g.camera.lookAt(this._lookTarget);

    // Inherit ship roll slightly (keeps movement feel tight).
    this._playerUp.set(0, 1, 0).applyQuaternion(this._playerQuat);
    g.camera.up.lerp(this._playerUp, upLerp);

    const baseFov = typeof cfg.fov === 'number' ? cfg.fov : 60;
    const boostFov = typeof cfg.boostFov === 'number' ? cfg.boostFov : 70;
    const targetFOV = keyDown('KeyZ') ? boostFov : baseFov;
    g.camera.fov = THREE.MathUtils.lerp(g.camera.fov, targetFOV, fovLerp);
    g.camera.updateProjectionMatrix();
  }
}
