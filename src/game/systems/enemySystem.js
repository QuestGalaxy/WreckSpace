import * as THREE from 'three';
import { V1 } from '../../balance/v1.js';
import { createVoxelShipModel } from '../../render/voxelShipFactory.js';

export class EnemySystem {
  /** @param {import('../../game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {THREE.Mesh[]} */
    this.enemyBullets = [];
    this._spawned = false;

    this._enemyState = new Map();

    this._toTarget = new THREE.Vector3();
    this._playerPos = new THREE.Vector3();
    this._moveDir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._targetPos = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();

    this._enemyShipByKind = {
      enemy_scout: V1.ships.scout,
      enemy_striker: V1.ships.balanced,
      enemy_tank: V1.ships.miner
    };
    this._enemyMeshTemplates = new Map();
  }

  update(dtSec, nowSec) {
    const g = this.game;
    if (!g.scene || !g.playerEntityId) return;
    this._ensureInitialSpawn();

    const pt = g.world.transform.get(g.playerEntityId);
    if (!pt) return;
    this._playerPos.set(pt.x, pt.y, pt.z);
    this._cleanupEnemyState();

    for (const [entityId, meta] of g.world.objectMeta) {
      if (meta?.type !== 'enemy') continue;
      const t = g.world.transform.get(entityId);
      if (!t) continue;
      const obj = g.renderRegistry.get(entityId);
      if (!obj) continue;

      const state = this._enemyState.get(entityId);
      if (!state) continue;

      this._updateEnemyTarget(entityId, state, nowSec);
      const targetId = state.targetEntityId;
      const targetTransform = targetId ? g.world.transform.get(targetId) : null;
      const hasTarget = !!targetTransform;

      if (hasTarget) this._targetPos.set(targetTransform.x, targetTransform.y, targetTransform.z);
      else this._targetPos.copy(this._playerPos);

      this._toTarget.subVectors(this._targetPos, this._tmp.set(t.x, t.y, t.z));
      const dist = Math.max(0.0001, this._toTarget.length());
      this._toTarget.multiplyScalar(1 / dist);

      const kindCfg = V1.targets?.[meta.kind] ?? {};
      const enemyCfg = kindCfg.enemy ?? {};
      const shipCfg = state.shipData ?? V1.ships.balanced;
      const baseSpeed = enemyCfg.moveSpeed ?? 6;
      const speed = baseSpeed * (shipCfg.speed ?? 1);
      const stopDist = enemyCfg.stopDistance ?? 280;
      const strafe = enemyCfg.strafe ?? 0;

      const orbit = this._moveDir.set(-this._toTarget.z, 0, this._toTarget.x)
        .multiplyScalar(strafe * (0.6 + 0.4 * Math.sin(nowSec * 1.3 + entityId * 0.31)));

      const toward = Math.max(0, dist - stopDist);
      const approach = Math.min(1, toward / Math.max(1, stopDist));
      const desiredVx = this._toTarget.x * speed * approach + orbit.x;
      const desiredVy = this._toTarget.y * speed * 0.35 + orbit.y;
      const desiredVz = this._toTarget.z * speed * approach + orbit.z;

      const vel = g.world.velocity.get(entityId) ?? { x: 0, y: 0, z: 0 };
      const blend = Math.min(1, dtSec * 3.2);
      vel.x += (desiredVx - vel.x) * blend;
      vel.y += (desiredVy - vel.y) * blend;
      vel.z += (desiredVz - vel.z) * blend;
      g.world.velocity.set(entityId, vel);

      t.x += vel.x * dtSec;
      t.y += vel.y * dtSec;
      t.z += vel.z * dtSec;

      obj.position.set(t.x, t.y, t.z);
      obj.lookAt(this._targetPos);

      const cd = enemyCfg.shotCooldownSec ?? 2;
      const nextShotAt = obj.userData.nextShotAtSec ?? 0;
      const shotRange = enemyCfg.shotRange ?? 900;
      if (dist < shotRange && nowSec >= nextShotAt) {
        const bulletSpeed = enemyCfg.bulletSpeed ?? 9;
        this._shootEnemy(entityId, obj, bulletSpeed, targetId ?? g.playerEntityId, dist, shotRange);
        obj.userData.nextShotAtSec = nowSec + cd;
      }

      this._collectNearbyLoot(entityId, obj, state);
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
    const shipData = this._enemyShipByKind[kind] ?? V1.ships.balanced;
    const hp = Math.max(V1.targets?.[kind]?.hp ?? 40, shipData.hull ?? 100);

    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = (1500 + Math.random() * 3500) * ws;
      const y = (Math.random() - 0.5) * 700 * ws;
      const pos = new THREE.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r);

      const mesh = this._createEnemyMesh(kind, shipData);
      mesh.position.copy(pos);
      mesh.userData.type = 'enemy';
      mesh.userData.enemyKind = kind;
      mesh.userData.cargoManifest = [];

      const id = g.world.createObject({ type: 'enemy', kind, hp, maxHp: hp });
      g.renderRegistry.bind(id, mesh);
      g.world.transform.set(id, { x: pos.x, y: pos.y, z: pos.z, rx: 0, ry: 0, rz: 0, sx: mesh.scale.x, sy: mesh.scale.y, sz: mesh.scale.z });
      g.world.velocity.set(id, { x: 0, y: 0, z: 0 });
      g.scene.add(mesh);
      g.objects.push(mesh);
      g.createHealthBar(mesh);

      this._enemyState.set(id, {
        shipData,
        cargoUsed: 0,
        cargoMax: shipData.cargo ?? 30,
        targetEntityId: g.playerEntityId,
        nextRetargetAtSec: 0
      });
    }
  }

  _createEnemyMesh(kind, shipData) {
    const g = this.game;
    const templateKey = kind;
    const cached = this._enemyMeshTemplates.get(templateKey);
    if (cached) return this._cloneEnemyTemplate(cached);

    let template = null;
    if (!g._voxelTextures || !g._voxLit) {
      const ws = g.worldScale ?? 1;
      const geo = new THREE.BoxGeometry(12 * ws, 6 * ws, 18 * ws);
      template = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xff6666, emissive: 0x220808, roughness: 0.8, metalness: 0.2, flatShading: true }));
      template.userData.hitRadius = 10 * ws;
    } else {
      const enemyShipData = {
        ...(shipData ?? V1.ships.balanced),
        color: 0xff5f66
      };

      const { group, bounds } = createVoxelShipModel({
        shipData: enemyShipData,
        voxelSize: g.voxel?.size ?? 5,
        textures: g._voxelTextures,
        theme: g.theme,
        voxLit: (opts) => g._voxLit(opts)
      });

      const size = bounds?.size ?? new THREE.Vector3(24, 12, 30);
      group.userData.hitRadius = Math.max(size.x, size.y, size.z) * 0.45;

      group.traverse((n) => {
        if (!n?.isMesh || !n.material?.color) return;
        n.material = n.material.clone();
        if (n.material?.emissive) {
          n.material.emissive = n.material.emissive.clone();
          n.material.emissive.offsetHSL(0, 0, 0.02);
        }
      });
      template = group;
    }

    this._enemyMeshTemplates.set(templateKey, template);
    return this._cloneEnemyTemplate(template);
  }

  _cloneEnemyTemplate(template) {
    const clone = template.clone(true);
    clone.userData = {
      ...(template.userData ?? {}),
      type: 'enemy',
      enemyKind: null,
      cargoManifest: []
    };
    clone.traverse((n) => {
      if (!n?.isMesh || !n.material) return;
      n.material = n.material.clone();
      if (n.material?.emissive?.clone) n.material.emissive = n.material.emissive.clone();
    });
    return clone;
  }

  _cleanupEnemyState() {
    for (const id of this._enemyState.keys()) {
      if (!this.game.world.objectMeta.has(id)) this._enemyState.delete(id);
    }
  }

  _updateEnemyTarget(entityId, state, nowSec) {
    const g = this.game;
    if ((state.nextRetargetAtSec ?? 0) > nowSec) return;
    state.nextRetargetAtSec = nowSec + 0.4 + Math.random() * 0.3;

    const t = g.world.transform.get(entityId);
    if (!t) return;

    const enemyObj = g.renderRegistry.get(entityId);
    const recentlyHit = ((enemyObj?.userData?.lastHitByPlayerAtSec ?? -999) + 6) > nowSec;

    // Human-like priority: immediate threats first.
    if (g.playerEntityId) {
      const pt = g.world.transform.get(g.playerEntityId);
      if (pt) {
        const dx = pt.x - t.x;
        const dy = pt.y - t.y;
        const dz = pt.z - t.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const closeThreat = d2 < (900 * 900);
        if (closeThreat || recentlyHit) {
          state.targetEntityId = g.playerEntityId;
          return;
        }
      }
    }

    let lootTarget = null;
    let lootDist = Infinity;
    if ((state.cargoUsed ?? 0) < (state.cargoMax ?? 0)) {
      for (const [lootId] of g.world.loot) {
        const lt = g.world.transform.get(lootId);
        if (!lt) continue;
        const dx = lt.x - t.x;
        const dy = lt.y - t.y;
        const dz = lt.z - t.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < lootDist) {
          lootDist = d2;
          lootTarget = lootId;
        }
      }
    }

    // Opportunistic loot only if no urgent combat context.
    if (lootTarget && lootDist < 1200 * 1200) {
      state.targetEntityId = lootTarget;
      return;
    }

    let objTarget = null;
    let objDist = Infinity;
    for (const [otherId, meta] of g.world.objectMeta) {
      if (otherId === entityId) continue;
      if (!meta || (meta.type !== 'planet' && meta.type !== 'asteroid')) continue;
      const ot = g.world.transform.get(otherId);
      if (!ot) continue;
      const dx = ot.x - t.x;
      const dy = ot.y - t.y;
      const dz = ot.z - t.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < objDist) {
        objDist = d2;
        objTarget = otherId;
      }
    }

    if (objTarget && objDist < 2200 * 2200) {
      state.targetEntityId = objTarget;
      return;
    }

    state.targetEntityId = g.playerEntityId;
  }

  _collectNearbyLoot(entityId, obj, state) {
    const g = this.game;
    if ((state.cargoUsed ?? 0) >= (state.cargoMax ?? 0)) return;

    const pickupRadius = (g.worldScale ?? 1) * 28;
    const pickupR2 = pickupRadius * pickupRadius;

    for (const [lootId, meta] of g.world.loot) {
      if ((state.cargoUsed ?? 0) >= (state.cargoMax ?? 0)) break;
      const lt = g.world.transform.get(lootId);
      if (!lt) continue;
      const dx = lt.x - obj.position.x;
      const dy = lt.y - obj.position.y;
      const dz = lt.z - obj.position.z;
      if (dx * dx + dy * dy + dz * dz > pickupR2) continue;

      const lootObj = g.renderRegistry.get(lootId);
      if (lootObj) {
        g.scene.remove(lootObj);
        if (g.spawner?.releaseLoot) g.spawner.releaseLoot(lootObj);
      }
      g.renderRegistry.unbind(lootId);
      g.world.removeEntity(lootId);

      const value = Math.max(1, Math.round(meta.value ?? 1));
      obj.userData.cargoManifest.push({
        type: meta.type ?? 'coin',
        value,
        powerupId: meta.powerupId ?? null
      });
      state.cargoUsed = (state.cargoUsed ?? 0) + 1;
    }
  }

  _shootEnemy(ownerEntityId, ownerObj, bulletSpeed, targetEntityId, distToTarget, shotRange) {
    const g = this.game;
    if (!targetEntityId || !g.scene) return;
    const tt = g.world.transform.get(targetEntityId);
    if (!tt) return;

    this._from.copy(ownerObj.position);
    this._to.set(tt.x, tt.y, tt.z);
    const dir = this._to.sub(this._from).normalize();

    const missScale = Math.max(0.015, 0.11 * (distToTarget / Math.max(1, shotRange)));
    dir.x += (Math.random() - 0.5) * missScale;
    dir.y += (Math.random() - 0.5) * missScale;
    dir.z += (Math.random() - 0.5) * missScale;
    dir.normalize();

    const ws = g.worldScale ?? 1;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.1 * ws, 1.1 * ws, 4 * ws),
      new THREE.MeshBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending })
    );
    mesh.position.copy(this._from);
    mesh.lookAt(this._from.clone().add(dir));

    const bId = g.world.createBullet({
      x: this._from.x,
      y: this._from.y,
      z: this._from.z,
      vx: dir.x * bulletSpeed * ws,
      vy: dir.y * bulletSpeed * ws,
      vz: dir.z * bulletSpeed * ws,
      life: 220,
      ownerEntityId,
      targetEntityId
    });
    mesh.userData.entityId = bId;

    g.scene.add(mesh);
    this.enemyBullets.push(mesh);
  }

  _updateEnemyBullets(dtSec) {
    const g = this.game;
    const ws = g.worldScale ?? 1;
    const shipR = g.shipCollisionRadiusWorld ?? (14 * ws);

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
      if (!remove) {
        remove = this._checkEnemyBulletHit(b, shipR);
      }

      if (remove) {
        g.scene.remove(m);
        this.enemyBullets.splice(i, 1);
        g.world.removeEntity(id);
      }
    }
  }

  _checkEnemyBulletHit(bullet, shipR) {
    const g = this.game;
    const pt = g.playerEntityId ? g.world.transform.get(g.playerEntityId) : null;
    if (pt) {
      const dx = bullet.x - pt.x;
      const dy = bullet.y - pt.y;
      const dz = bullet.z - pt.z;
      if (dx * dx + dy * dy + dz * dz <= shipR * shipR) {
        const owner = bullet.ownerEntityId ? g.world.objectMeta.get(bullet.ownerEntityId) : null;
        const dmg = V1.targets?.[owner?.kind]?.enemy?.shotDamage ?? 6;
        g.applyShipDamage(dmg);
        g.vfx.createHitEffect(new THREE.Vector3(pt.x, pt.y, pt.z));
        return true;
      }
    }

    for (const [entityId, meta] of g.world.objectMeta) {
      if (!meta || (meta.type !== 'planet' && meta.type !== 'asteroid')) continue;
      const t = g.world.transform.get(entityId);
      if (!t) continue;
      const r = Math.max(6 * (g.worldScale ?? 1), (t.sx ?? 1) * 0.52);
      const dx = bullet.x - t.x;
      const dy = bullet.y - t.y;
      const dz = bullet.z - t.z;
      if (dx * dx + dy * dy + dz * dz > r * r) continue;

      const owner = bullet.ownerEntityId ? g.world.objectMeta.get(bullet.ownerEntityId) : null;
      const dmg = V1.targets?.[owner?.kind]?.enemy?.shotDamage ?? 6;
      const h = g.world.damage(entityId, dmg);
      g.vfx.createHitEffect(new THREE.Vector3(bullet.x, bullet.y, bullet.z));

      const obj = g.renderRegistry.get(entityId);
      if (obj?.userData?.healthBar) {
        obj.userData.healthBar.sprite.visible = true;
        g.updateHealthBar(obj);
      }

      if (h && h.hp <= 0) g.destroyObjectEntity(entityId);
      return true;
    }

    return false;
  }
}
