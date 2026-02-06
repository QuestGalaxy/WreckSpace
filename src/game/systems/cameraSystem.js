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
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void nowSec;
    const g = this.game;
    if (!g.player || !g.camera) return;

    const k = dtSec * 60;
    const follow = 1 - Math.pow(1 - 0.08, k);
    const upLerp = 1 - Math.pow(1 - 0.1, k);
    const fovLerp = 1 - Math.pow(1 - 0.04, k);

    const offsetZ = g.keys['KeyZ'] ? -30 : -25;
    const offsetY = g.keys['KeyZ'] ? 12 : 14;

    this._idealOffset.set(0, offsetY, offsetZ);

    if (g.keys['KeyZ'] || g.cameraShake > 0) {
      const shakeAmt = g.keys['KeyZ'] ? 0.2 : g.cameraShake;
      this._idealOffset.x += (Math.random() - 0.5) * shakeAmt;
      this._idealOffset.y += (Math.random() - 0.5) * shakeAmt;
      if (g.cameraShake > 0) g.cameraShake *= Math.pow(0.9, k);
    }

    this._worldOffset.copy(this._idealOffset).applyMatrix4(g.player.matrixWorld);
    g.camera.position.lerp(this._worldOffset, follow);

    this._lookTarget.set(0, 0, 60).applyMatrix4(g.player.matrixWorld);
    g.camera.lookAt(this._lookTarget);

    this._playerUp.set(0, 1, 0).applyQuaternion(g.player.quaternion);
    g.camera.up.lerp(this._playerUp, upLerp);

    const targetFOV = g.keys['KeyZ'] ? 70 : 60;
    g.camera.fov = THREE.MathUtils.lerp(g.camera.fov, targetFOV, fovLerp);
    g.camera.updateProjectionMatrix();
  }
}

