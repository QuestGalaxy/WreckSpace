import * as THREE from 'three';

export class MovementSystem {
  /**
   * @param {import('../../game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    this._forwardDir = new THREE.Vector3();
    this._left = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._enginePos = new THREE.Vector3();
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    void nowSec;
    const g = this.game;
    if (!g.player) return;

    // Keep behavior stable even if stepHz changes.
    const k = dtSec * 60;

    if (!g.player.userData.velocity) g.player.userData.velocity = new THREE.Vector3();

    const pitchSpeed = 0.010 * k;
    const yawSpeed = 0.010 * k;
    const rollSpeed = 0.015 * k;
    const acceleration = (g.keys['KeyZ'] ? 0.08 : 0.04) * k;
    const friction = Math.pow(0.98, k); // convert per-tick friction to dt-aware

    // Rotational Input (Direct Control)
    if (g.keys['ArrowUp'] || g.keys['KeyW']) g.player.rotateX(-pitchSpeed);
    if (g.keys['ArrowDown'] || g.keys['KeyS']) g.player.rotateX(pitchSpeed);

    if (g.keys['ArrowLeft'] || g.keys['KeyA']) {
      g.player.rotateY(yawSpeed);
      g.player.rotateZ(rollSpeed * 0.6);
    }
    if (g.keys['ArrowRight'] || g.keys['KeyD']) {
      g.player.rotateY(-yawSpeed);
      g.player.rotateZ(-rollSpeed * 0.6);
    }

    // Manual Roll
    if (g.keys['KeyQ']) g.player.rotateZ(rollSpeed);
    if (g.keys['KeyE']) g.player.rotateZ(-rollSpeed);

    // Velocity & Thrust Calculation
    const targetSpeedVal = g.keys['KeyZ'] ? 5.0 : 2.5;
    g.currentSpeed = THREE.MathUtils.lerp(g.currentSpeed, targetSpeedVal, 0.05);

    this._forwardDir.set(0, 0, 1).applyQuaternion(g.player.quaternion);
    g.player.userData.velocity.add(this._forwardDir.multiplyScalar(acceleration * g.currentSpeed * 0.1));

    g.player.userData.velocity.multiplyScalar(friction);
    g.player.position.add(g.player.userData.velocity);

    // Dodge (Side Thrusters)
    if (g.keys['ShiftLeft'] || g.keys['ShiftRight']) {
      const strafeForce = 0.05 * k;
      if (g.keys['ArrowLeft'] || g.keys['KeyA']) {
        this._left.set(1, 0, 0).applyQuaternion(g.player.quaternion);
        g.player.userData.velocity.add(this._left.multiplyScalar(strafeForce));
      }
      if (g.keys['ArrowRight'] || g.keys['KeyD']) {
        this._right.set(-1, 0, 0).applyQuaternion(g.player.quaternion);
        g.player.userData.velocity.add(this._right.multiplyScalar(strafeForce));
      }
    }

    // Engine Trails (VFX creation still lives in Game for now)
    if (g.engineOffsets) {
      g.engineOffsets.forEach((offset) => {
        this._enginePos.copy(offset).applyMatrix4(g.player.matrixWorld);
        if (Math.random() > 0.4) g.vfx.spawnEngineTrail(this._enginePos, g.keys['KeyZ']);
      });
    }
  }
}
