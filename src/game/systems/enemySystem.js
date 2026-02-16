import * as THREE from 'three';
import { V1 } from '../../balance/v1.js';

export class EnemySystem {
  /** @param {import('../../game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {THREE.Mesh[]} */
    this.enemyBullets = [];
    this._spawned = false;

    this._toPlayer = new THREE.Vector3();
    this._playerPos = new THREE.Vector3();
  }

  update(dtSec, nowSec) {
    const g = this.game;
    if (!g.scene || !g.playerEntityId) return;
    this._ensureInitialSpawn();

    const pt = g.world.transform.get(g.playerEntityId);
    if (!pt) return;
    this._playerPos.set(pt.x, pt.y, pt.z);

    for (const [entityId, meta] of g.world.objectMeta) {
      if (!meta?.type || meta.type !== 'enemy') continue;
      const t = g.world.transform.get(entityId);
      if (!t) continue;
      const obj = g.renderRegistry.get(entityId);
      if (!obj) continue;

      this._toPlayer.set(this._playerPos.x - t.x, this._playerPos.y - t.y, this._playerPos.z - t.z);
      const dist = this._toPlayer.length();
      if (dist > 0.001) this._toPlayer.multiplyScalar(1 / dist);

      const kindCfg = V1.targets?.[meta.kind] ?? {};
      const speed = kindCfg.enemy?.moveSpeed ?? 6;
      const stopDist = kindCfg.enemy?.stopDistance ?? 280;
      const strafe = kindCfg.enemy?.strafe ?? 0;
      const orbit = new THREE.Vector3(-this._toPlayer.z, 0, this._toPlayer.x).multiplyScalar(strafe);

      const toward = Math.max(0, dist - stopDist);
      const vx = this._toPlayer.x * speed * Math.min(1, toward / Math.max(1, stopDist)) + orbit.x;
      const vy = this._toPlayer.y * speed * 0.35 + orbit.y;
      const vz = this._toPlayer.z * speed * Math.min(1, toward / Math.max(1, stopDist)) + orbit.z;

      t.x += vx * dtSec;
      t.y += vy * dtSec;
      t.z += vz * dtSec;

      obj.position.set(t.x, t.y, t.z);
      obj.lookAt(this._playerPos);

      const cd = kindCfg.enemy?.shotCooldownSec ?? 2;
      const nextShotAt = obj.userData.nextShotAtSec ?? 0;
      if (dist < (kindCfg.enemy?.shotRange ?? 900) && nowSec >= nextShotAt) {
        this._shootEnemy(entityId, obj, kindCfg.enemy?.bulletSpeed ?? 9);
        obj.userData.nextShotAtSec = nowSec + cd;
      }
    }

    this._updateEnemyBullets(dtSec);
  }

  _ensureInitialSpawn() {
    if (this._spawned) return;
    this._spawned = true;
    const cfg = V1.spawn?.enemies ?? { scout: 5, striker: 3, tank: 2 };
    this._spawnEnemyKind('enemy_scout', cfg.scout ?? 0);
    this._spawnEnemyKind('enemy_striker', cfg.striker ?? 0);
    this._spawnEnemyKind('enemy_tank', cfg.tank ?? 0);
  }

  _spawnEnemyKind(kind, count) {
    const g = this.game;
    const ws = g.worldScale ?? 1;
    const hp = V1.targets?.[kind]?.hp ?? 40;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = (1500 + Math.random() * 3500) * ws;
      const y = (Math.random() - 0.5) * 700 * ws;
      const pos = new THREE.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r);

      const mesh = this._createEnemyMesh(kind);
      mesh.position.copy(pos);
      mesh.userData.type = 'enemy';

      const id = g.world.createObject({ type: 'enemy', kind, hp, maxHp: hp });
      g.renderRegistry.bind(id, mesh);
      g.world.transform.set(id, { x: pos.x, y: pos.y, z: pos.z, rx: 0, ry: 0, rz: 0, sx: mesh.scale.x, sy: mesh.scale.y, sz: mesh.scale.z });
      g.scene.add(mesh);
      g.objects.push(mesh);
      g.createHealthBar(mesh);
    }
  }

  _createEnemyMesh(kind) {
    const g = this.game;
    const ws = g.worldScale ?? 1;
    const geo = new THREE.BoxGeometry(12 * ws, 6 * ws, 18 * ws);
    const color = kind === 'enemy_tank' ? 0xff5533 : kind === 'enemy_striker' ? 0xffcc33 : 0xff66aa;
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: 0x220808, roughness: 0.8, metalness: 0.2, flatShading: true }));
    if (kind === 'enemy_tank') mesh.scale.setScalar(1.45);
    if (kind === 'enemy_scout') mesh.scale.setScalar(0.9);
    return mesh;
  }

  _shootEnemy(ownerEntityId, ownerObj, bulletSpeed) {
    const g = this.game;
    if (!g.playerEntityId || !g.scene) return;
    const pt = g.world.transform.get(g.playerEntityId);
    if (!pt) return;

    const from = ownerObj.position.clone();
    const to = new THREE.Vector3(pt.x, pt.y, pt.z);
    const dir = to.sub(from).normalize();

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.1 * (g.worldScale ?? 1), 1.1 * (g.worldScale ?? 1), 4 * (g.worldScale ?? 1)),
      new THREE.MeshBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending })
    );
    mesh.position.copy(from);
    mesh.lookAt(new THREE.Vector3(pt.x, pt.y, pt.z));

    const bId = g.world.createBullet({
      x: from.x,
      y: from.y,
      z: from.z,
      vx: dir.x * bulletSpeed * (g.worldScale ?? 1),
      vy: dir.y * bulletSpeed * (g.worldScale ?? 1),
      vz: dir.z * bulletSpeed * (g.worldScale ?? 1),
      life: 220,
      ownerEntityId,
      targetEntityId: g.playerEntityId
    });
    mesh.userData.entityId = bId;

    g.scene.add(mesh);
    this.enemyBullets.push(mesh);
  }

  _updateEnemyBullets(dtSec) {
    const g = this.game;
    const pt = g.playerEntityId ? g.world.transform.get(g.playerEntityId) : null;
    const shipR = g.shipCollisionRadiusWorld ?? (14 * (g.worldScale ?? 1));

    for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
      const m = this.enemyBullets[i];
      const id = m?.userData?.entityId ?? null;
      const b = id ? g.world.bullet.get(id) : null;
      if (!b) {
        g.scene.remove(m);
        this.enemyBullets.splice(i, 1);
        continue;
      }

      b.x += b.vx * dtSec * 60;
      b.y += b.vy * dtSec * 60;
      b.z += b.vz * dtSec * 60;
      b.life -= 1;
      m.position.set(b.x, b.y, b.z);

      let remove = b.life <= 0;
      if (!remove && pt) {
        const dx = b.x - pt.x;
        const dy = b.y - pt.y;
        const dz = b.z - pt.z;
        if (dx * dx + dy * dy + dz * dz <= shipR * shipR) {
          const owner = b.ownerEntityId ? g.world.objectMeta.get(b.ownerEntityId) : null;
          const dmg = (V1.targets?.[owner?.kind]?.enemy?.shotDamage ?? 6);
          g.applyShipDamage(dmg);
          g.vfx.createHitEffect(new THREE.Vector3(pt.x, pt.y, pt.z));
          remove = true;
        }
      }

      if (remove) {
        g.scene.remove(m);
        this.enemyBullets.splice(i, 1);
        g.world.removeEntity(id);
      }
    }
  }
}
