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
    this._quat = new THREE.Quaternion();
    this._qTmp = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'XYZ');
    this._axisX = new THREE.Vector3(1, 0, 0);
    this._axisY = new THREE.Vector3(0, 1, 0);
    this._axisZ = new THREE.Vector3(0, 0, 1);

    // Rising-edge detection for throttle keys.
    this._throttleUpPrev = false;
    this._throttleDownPrev = false;

    /** @type {number} */
    this._lastUpTapSec = -1e9;
    /** @type {number} */
    this._lastDownTapSec = -1e9;
  }

  /**
   * @param {number} dtSec
   * @param {number} nowSec
   */
  update(dtSec, nowSec) {
    const g = this.game;
    if (!g.playerEntityId || !g.player) return;

    // Keep behavior stable even if stepHz changes.
    const k = dtSec * 60;

    const ws = g.worldScale ?? 1;
    const pitchSpeed = 0.010 * k;
    const yawSpeed = 0.010 * k;
    const rollSpeed = 0.015 * k;
    // Acceleration is scaled by worldScale so voxel scaling doesn't change feel.
    const acceleration = (g.keys['KeyZ'] ? 0.08 : 0.04) * k * ws;
    const friction = Math.pow(0.98, k); // convert per-tick friction to dt-aware

    const t = g.world.transform.get(g.playerEntityId);
    const v = g.world.velocity.get(g.playerEntityId);
    const rq = g.world.rotationQuat.get(g.playerEntityId);
    if (!t || !v || !rq) return;

    this._quat.set(rq.x, rq.y, rq.z, rq.w);

    // Rotational Input (local axes; match Object3D.rotateX/Y/Z semantics)
    if (g.keys['ArrowUp'] || g.keys['KeyW']) {
      this._qTmp.setFromAxisAngle(this._axisX, -pitchSpeed);
      this._quat.multiply(this._qTmp);
    }
    if (g.keys['ArrowDown'] || g.keys['KeyS']) {
      this._qTmp.setFromAxisAngle(this._axisX, pitchSpeed);
      this._quat.multiply(this._qTmp);
    }

    if (g.keys['ArrowLeft'] || g.keys['KeyA']) {
      this._qTmp.setFromAxisAngle(this._axisY, yawSpeed);
      this._quat.multiply(this._qTmp);
      this._qTmp.setFromAxisAngle(this._axisZ, rollSpeed * 0.6);
      this._quat.multiply(this._qTmp);
    }
    if (g.keys['ArrowRight'] || g.keys['KeyD']) {
      this._qTmp.setFromAxisAngle(this._axisY, -yawSpeed);
      this._quat.multiply(this._qTmp);
      this._qTmp.setFromAxisAngle(this._axisZ, -rollSpeed * 0.6);
      this._quat.multiply(this._qTmp);
    }

    // Manual Roll
    if (g.keys['KeyQ']) {
      this._qTmp.setFromAxisAngle(this._axisZ, rollSpeed);
      this._quat.multiply(this._qTmp);
    }
    if (g.keys['KeyE']) {
      this._qTmp.setFromAxisAngle(this._axisZ, -rollSpeed);
      this._quat.multiply(this._qTmp);
    }

    // Cruise speed ("gear") control: double-tap ArrowUp / ArrowDown.
    if (!g.throttle) g.throttle = { level: 3, min: 0, max: 10, step: 1 };
    const upNow = !!g.keys['ArrowUp'];
    const downNow = !!g.keys['ArrowDown'];
    const upTap = upNow && !this._throttleUpPrev;
    const downTap = downNow && !this._throttleDownPrev;

    const dblTapWindowSec = 0.33;
    if (upTap) {
      if (nowSec - this._lastUpTapSec <= dblTapWindowSec) {
        g.throttle.level = Math.min(g.throttle.max, g.throttle.level + g.throttle.step);
        if (g.showMessage) g.showMessage(`Speed ${g.throttle.level}/${g.throttle.max}`);
        this._lastUpTapSec = -1e9;
      } else {
        this._lastUpTapSec = nowSec;
      }
    }
    if (downTap) {
      if (nowSec - this._lastDownTapSec <= dblTapWindowSec) {
        g.throttle.level = Math.max(g.throttle.min, g.throttle.level - g.throttle.step);
        if (g.showMessage) g.showMessage(`Speed ${g.throttle.level}/${g.throttle.max}`);
        this._lastDownTapSec = -1e9;
      } else {
        this._lastDownTapSec = nowSec;
      }
    }

    this._throttleUpPrev = upNow;
    this._throttleDownPrev = downNow;

    // Velocity & Thrust Calculation
    // `level` is in "meters-ish"; multiply by worldScale to keep feel stable with voxel scaling.
    const level = g.throttle.level;
    const maxLevel = g.throttle.max;
    const boostedLevel = g.keys['KeyZ'] ? Math.min(maxLevel, level + 2) : level;
    const targetSpeedVal = boostedLevel * ws;
    const speedLerp = 1 - Math.pow(1 - 0.05, k);
    g.currentSpeed = THREE.MathUtils.lerp(g.currentSpeed, targetSpeedVal, speedLerp);

    this._forwardDir.set(0, 0, 1).applyQuaternion(this._quat);
    v.x += this._forwardDir.x * (acceleration * g.currentSpeed * 0.1);
    v.y += this._forwardDir.y * (acceleration * g.currentSpeed * 0.1);
    v.z += this._forwardDir.z * (acceleration * g.currentSpeed * 0.1);

    v.x *= friction;
    v.y *= friction;
    v.z *= friction;

    t.x += v.x;
    t.y += v.y;
    t.z += v.z;

    // Dodge (Side Thrusters)
    if (g.keys['ShiftLeft'] || g.keys['ShiftRight']) {
      const strafeForce = 0.05 * k;
      if (g.keys['ArrowLeft'] || g.keys['KeyA']) {
        this._left.set(1, 0, 0).applyQuaternion(this._quat);
        v.x += this._left.x * strafeForce;
        v.y += this._left.y * strafeForce;
        v.z += this._left.z * strafeForce;
      }
      if (g.keys['ArrowRight'] || g.keys['KeyD']) {
        this._right.set(-1, 0, 0).applyQuaternion(this._quat);
        v.x += this._right.x * strafeForce;
        v.y += this._right.y * strafeForce;
        v.z += this._right.z * strafeForce;
      }
    }

    // Store back rotation to world.
    rq.x = this._quat.x;
    rq.y = this._quat.y;
    rq.z = this._quat.z;
    rq.w = this._quat.w;
    this._euler.setFromQuaternion(this._quat, 'XYZ');
    t.rx = this._euler.x;
    t.ry = this._euler.y;
    t.rz = this._euler.z;

    // Sync render mesh from world (player is still a Three Group for now)
    g.player.position.set(t.x, t.y, t.z);
    g.player.quaternion.copy(this._quat);

    // Engine Trails
    if (g.engineOffsets) {
      g.engineOffsets.forEach((offset) => {
        this._enginePos.copy(offset).applyQuaternion(this._quat).add(g.player.position);
        if (Math.random() > 0.4) g.vfx.spawnEngineTrail(this._enginePos, g.keys['KeyZ']);
      });
    }
  }
}
