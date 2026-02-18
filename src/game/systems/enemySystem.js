import * as THREE from 'three';
import { V1 } from '../../balance/v1.js';
import { createVoxelShipModel } from '../../render/voxelShipFactory.js';

export class EnemySystem {
  /** @param {import('../../game.js').Game} game */
  constructor(game) {
    this.game = game;
    this._preset = game.enemyAiPresetCfg ?? V1.enemyAiPresets.balanced;
    this._characterPresetIds = ['aggressive', 'balanced', 'cowardly'];
    /** @type {THREE.Mesh[]} */
    this.enemyBullets = [];
    this._spawned = false;

    this._enemyState = new Map();
    this._teamEconomy = new Map();
    this._spawnSeq = 0;

    this._toTarget = new THREE.Vector3();
    this._playerPos = new THREE.Vector3();
    this._moveDir = new THREE.Vector3();
    this._strafeVec = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._targetPos = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._basePos = new THREE.Vector3();

    this._economyCfg = {
      baseHp: 720,
      baseRadius: 120,
      depositRadius: 95,
      spendEverySec: [3.6, 6.2],
      spawnEverySec: [6.5, 10.5],
      maxUpgrades: 5,
      upgradeCosts: {
        speed: { coin: [120, 200, 320, 500, 760], gem: [20, 35, 55, 75, 110] },
        damage: { coin: [160, 260, 390, 580, 820], gem: [24, 38, 58, 85, 120] },
        hp: { coin: [180, 280, 420, 620, 890], gem: [28, 45, 66, 94, 130] },
        cargo: { coin: [100, 180, 280, 430, 620], gem: [16, 26, 40, 56, 78] }
      },
      reinforcementCosts: {
        enemy_scout: { coin: 110, gem: 10 },
        enemy_striker: { coin: 190, gem: 18 },
        enemy_tank: { coin: 310, gem: 28 }
      }
    };

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
    this._updateTeamEconomy(nowSec);

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
      const eco = this._teamEconomy.get(state.teamId ?? 0);
      const h = g.world.getHealth(entityId);
      const hpRatio = h && h.maxHp > 0 ? h.hp / h.maxHp : 1;
      const playerHullRatio = (g.shipDerived?.maxHull ?? 0) > 0
        ? (g.stats.hull ?? 0) / (g.shipDerived.maxHull ?? 1)
        : 1;
      const recentlyHit = ((obj.userData?.lastHitByPlayerAtSec ?? -999) + 2.6) > nowSec;
      const baseSpeed = enemyCfg.moveSpeed ?? 6;
      const teamSpeedMul = eco?.mult?.speed ?? 1;
      const teamDamageMul = eco?.mult?.damage ?? 1;
      const teamCargoMul = eco?.mult?.cargo ?? 1;
      state.cargoMax = Math.max(8, Math.round((shipCfg.cargo ?? 30) * teamCargoMul));
      const speed = baseSpeed * (shipCfg.speed ?? 1) * (state.speedMul ?? (this._preset.speedMul ?? 1)) * teamSpeedMul;
      const stopDist = enemyCfg.stopDistance ?? 280;
      const shotRange = enemyCfg.shotRange ?? 900;
      const strafe = (enemyCfg.strafe ?? 0) * (state.strafeMul ?? (this._preset.strafeMul ?? 1));
      const targetIsPlayer = targetId === g.playerEntityId;
      const behavior = this._updateBehaviorState(state, {
        nowSec,
        dist,
        stopDist,
        shotRange,
        hpRatio,
        playerHullRatio,
        recentlyHit,
        targetIsPlayer
      });

      let desiredRange = stopDist;
      let forwardBias = 0.25;
      let strafeMul = 1.0;
      let shootCadenceMul = 1.0;
      switch (behavior) {
        case 'chase':
          forwardBias = 1.15;
          strafeMul = 1.0;
          desiredRange = stopDist * 1.1;
          break;
        case 'pressure':
          forwardBias = 1.0;
          strafeMul = 1.25;
          desiredRange = stopDist * 0.8;
          shootCadenceMul = 0.82;
          break;
        case 'kite':
          forwardBias = -0.55;
          strafeMul = 1.8;
          desiredRange = stopDist * 1.2;
          shootCadenceMul = 1.18;
          break;
        case 'flee':
          forwardBias = -1.35;
          strafeMul = 1.9;
          desiredRange = stopDist * 1.6;
          shootCadenceMul = 1.55;
          break;
        case 'evade':
          forwardBias = -0.7;
          strafeMul = 2.2;
          desiredRange = stopDist * 1.05;
          shootCadenceMul = 1.28;
          break;
        default:
          forwardBias = 0.55;
          strafeMul = 1.8;
          desiredRange = stopDist;
          break;
      }

      const toward = Math.max(0, dist - desiredRange);
      const approach = Math.min(1, toward / Math.max(1, desiredRange));
      const tooClose = Math.max(0, desiredRange - dist);
      const repel = Math.min(1, tooClose / Math.max(1, desiredRange));
      const distanceDrive = approach - repel;
      const forwardGain = forwardBias + distanceDrive * 0.95;

      const strafePulse = 0.65 + 0.35 * Math.sin(nowSec * (1.4 + (state.seed ?? 0) * 0.015) + (state.seed ?? 0));
      const strafeSpeed = strafe * strafeMul * strafePulse * (state.strafeDir ?? 1);
      this._strafeVec.set(-this._toTarget.z, 0, this._toTarget.x);
      if (this._strafeVec.lengthSq() > 0.000001) this._strafeVec.normalize().multiplyScalar(strafeSpeed);

      if (recentlyHit && nowSec >= (state.nextEvadeAtSec ?? 0)) {
        const side = Math.random() < 0.5 ? -1 : 1;
        state.evadeVec.set(this._toTarget.z * side, (Math.random() - 0.5) * 0.35, -this._toTarget.x * side).normalize();
        state.evadeUntilSec = nowSec + 0.7 + Math.random() * 0.4;
        state.nextEvadeAtSec = nowSec + 1.0 + Math.random() * 0.7;
      }
      const evadeScale = (state.evadeUntilSec ?? 0) > nowSec
        ? speed * Math.min(1.4, (state.evadeUntilSec - nowSec) * 2.2)
        : 0;
      const bob = Math.sin(nowSec * (1.8 + ((state.seed ?? 0) % 0.8)) + (state.seed ?? 0)) * speed * 0.2;

      const desiredVx = this._toTarget.x * speed * forwardGain + this._strafeVec.x + (state.evadeVec.x * evadeScale);
      const desiredVy = this._toTarget.y * speed * (0.25 + forwardGain * 0.18) + bob + (state.evadeVec.y * evadeScale);
      const desiredVz = this._toTarget.z * speed * forwardGain + this._strafeVec.z + (state.evadeVec.z * evadeScale);

      const vel = g.world.velocity.get(entityId) ?? { x: 0, y: 0, z: 0 };
      const maxSpeed = speed * (behavior === 'flee' || behavior === 'evade' ? 2.35 : 2.0);
      const speedSq = desiredVx * desiredVx + desiredVy * desiredVy + desiredVz * desiredVz;
      let targetVx = desiredVx;
      let targetVy = desiredVy;
      let targetVz = desiredVz;
      if (speedSq > maxSpeed * maxSpeed) {
        const inv = maxSpeed / Math.sqrt(speedSq);
        targetVx *= inv;
        targetVy *= inv;
        targetVz *= inv;
      }

      const blendFactor = behavior === 'evade' || behavior === 'flee' ? 6.0 : 4.0;
      const blend = Math.min(1, dtSec * blendFactor);
      vel.x += (targetVx - vel.x) * blend;
      vel.y += (targetVy - vel.y) * blend;
      vel.z += (targetVz - vel.z) * blend;
      g.world.velocity.set(entityId, vel);

      const simStep = dtSec * 60;
      t.x += vel.x * simStep;
      t.y += vel.y * simStep;
      t.z += vel.z * simStep;

      obj.position.set(t.x, t.y, t.z);
      obj.lookAt(this._targetPos);

      const cd = enemyCfg.shotCooldownSec ?? 2;
      const nextShotAt = obj.userData.nextShotAtSec ?? 0;
      const shouldShoot = state.targetKind !== 'ally_base';
      if (shouldShoot && dist < shotRange && nowSec >= nextShotAt) {
        const bulletSpeed = enemyCfg.bulletSpeed ?? 9;
        const shotDamage = (enemyCfg.shotDamage ?? 6) * teamDamageMul;
        this._shootEnemy(entityId, obj, bulletSpeed, targetId ?? g.playerEntityId, dist, shotRange, shotDamage);
        obj.userData.nextShotAtSec = nowSec + (cd * shootCadenceMul);
      }

      this._collectNearbyLoot(entityId, obj, state);
      this._tryDepositCargo(entityId, obj, state, nowSec);
    }

    this._updateEnemyBullets(dtSec);
  }

  _ensureInitialSpawn() {
    if (this._spawned) return;
    this._spawned = true;
    this._ensureTeamEconomy();
    const cfg = V1.spawn?.enemies ?? { scout: 5, striker: 3, tank: 2 };
    this._spawnEnemyKind('enemy_scout', cfg.scout ?? 0);
    this._spawnEnemyKind('enemy_striker', cfg.striker ?? 0);
    this._spawnEnemyKind('enemy_tank', cfg.tank ?? 0);
  }

  _spawnEnemyKind(kind, count) {
    for (let i = 0; i < count; i++) {
      const teamId = this._spawnSeq++ % 2;
      this._spawnEnemyUnit(kind, teamId);
    }
  }

  _spawnEnemyUnit(kind, teamId) {
    const g = this.game;
    if (!g.scene) return null;

    const ws = g.worldScale ?? 1;
    const shipData = this._enemyShipByKind[kind] ?? V1.ships.balanced;
    const hpBase = Math.max(1, V1.targets?.[kind]?.hp ?? 40);
    const eco = this._teamEconomy.get(teamId);
    const hpMul = eco?.mult?.hp ?? 1;
    const hp = Math.max(1, Math.round(hpBase * hpMul));

    const ang = Math.random() * Math.PI * 2;
    let pos = null;
    const baseT = eco?.baseEntityId ? g.world.transform.get(eco.baseEntityId) : null;
    if (baseT) {
      const r = (250 + Math.random() * 700) * ws;
      const y = (Math.random() - 0.5) * 360 * ws;
      pos = new THREE.Vector3(baseT.x + Math.cos(ang) * r, baseT.y + y, baseT.z + Math.sin(ang) * r);
    } else {
      const r = (1500 + Math.random() * 3500) * ws;
      const y = (Math.random() - 0.5) * 700 * ws;
      pos = new THREE.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r);
    }

    const mesh = this._createEnemyMesh(kind, shipData);
    mesh.position.copy(pos);
    mesh.userData.type = 'enemy';
    mesh.userData.enemyKind = kind;
    mesh.userData.teamId = teamId;
    mesh.userData.cargoManifest = [];

    const id = g.world.createObject({ type: 'enemy', kind, hp, maxHp: hp });
    g.renderRegistry.bind(id, mesh);
    g.world.transform.set(id, { x: pos.x, y: pos.y, z: pos.z, rx: 0, ry: 0, rz: 0, sx: mesh.scale.x, sy: mesh.scale.y, sz: mesh.scale.z });
    g.world.velocity.set(id, { x: 0, y: 0, z: 0 });
    g.scene.add(mesh);
    g.objects.push(mesh);
    g.createHealthBar(mesh);

    const characterId = this._characterPresetIds[Math.floor(Math.random() * this._characterPresetIds.length)] ?? 'balanced';
    const characterCfg = V1.enemyAiPresets?.[characterId] ?? V1.enemyAiPresets.balanced;
    const mul = (key) => (this._preset?.[key] ?? 1) * (characterCfg?.[key] ?? 1);
    const combatBias = THREE.MathUtils.clamp(((this._preset?.combatBias ?? 0.55) + (characterCfg?.combatBias ?? 0.55)) * 0.5, 0.08, 0.92);
    mesh.userData.aiCharacterId = characterId;
    mesh.userData.aiCharacter = characterCfg?.character ?? characterId;

    this._enemyState.set(id, {
      shipData,
      characterId,
      character: characterCfg?.character ?? characterId,
      speedMul: mul('speedMul'),
      strafeMul: mul('strafeMul'),
      missMul: mul('missMul'),
      fleeThresholdMul: mul('fleeThresholdMul'),
      modeDurationMul: mul('modeDurationMul'),
      commitDurationMul: mul('commitDurationMul'),
      combatBias,
      teamId,
      aggression: (0.7 + Math.random() * 0.8) * mul('aggressionMul'),
      caution: (0.65 + Math.random() * 0.8) * mul('cautionMul'),
      unpredictability: (0.75 + Math.random() * 0.6) * mul('unpredictabilityMul'),
      farmBias: 0.45 + Math.random() * 0.4,
      cargoUsed: 0,
      cargoMax: shipData.cargo ?? 30,
      targetEntityId: g.playerEntityId,
      targetKind: 'player',
      targetPowerRatio: 1,
      intent: 'fight',
      commitUntilSec: 0,
      objectiveMode: Math.random() < 0.5 ? 'combat' : 'farm',
      modeUntilSec: 0,
      nextRetargetAtSec: 0,
      behavior: 'chase',
      strafeDir: Math.random() < 0.5 ? -1 : 1,
      nextStrafeFlipAtSec: 0,
      evadeUntilSec: 0,
      nextEvadeAtSec: 0,
      evadeVec: new THREE.Vector3(),
      seed: Math.random() * 1000
    });
    return id;
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

  _ensureTeamEconomy() {
    if (this._teamEconomy.size >= 2) return;
    this._createTeamEconomy(0, new THREE.Vector3(-2200, 0, -1200));
    this._createTeamEconomy(1, new THREE.Vector3(2200, 0, 1200));
  }

  _createTeamEconomy(teamId, basePos) {
    const g = this.game;
    if (!g.scene) return;
    const ws = g.worldScale ?? 1;
    const pos = this._basePos.copy(basePos).multiplyScalar(ws);

    const base = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(17 * ws, 24 * ws, 18 * ws, 7),
      new THREE.MeshStandardMaterial({
        color: teamId === 0 ? 0xff756b : 0x6bb7ff,
        emissive: teamId === 0 ? 0x42100c : 0x0c2042,
        emissiveIntensity: 0.55,
        roughness: 0.72,
        metalness: 0.2,
        flatShading: true
      })
    );
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(28 * ws, 4 * ws, 8, 16),
      new THREE.MeshStandardMaterial({
        color: teamId === 0 ? 0xffb27c : 0x9ad0ff,
        emissive: teamId === 0 ? 0x4b2d10 : 0x102d4b,
        emissiveIntensity: 0.9,
        roughness: 0.65,
        metalness: 0.18,
        flatShading: true
      })
    );
    ring.rotation.x = Math.PI * 0.5;
    base.add(core, ring);
    base.position.copy(pos);
    base.userData.type = 'enemy_base';
    base.userData.teamId = teamId;
    base.userData.hitRadius = this._economyCfg.baseRadius * ws;

    const kind = `enemy_base_team${teamId}`;
    const hp = Math.max(220, Math.round(this._economyCfg.baseHp));
    const id = g.world.createObject({ type: 'enemy_base', kind, hp, maxHp: hp });
    g.renderRegistry.bind(id, base);
    g.world.transform.set(id, { x: pos.x, y: pos.y, z: pos.z, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    g.scene.add(base);
    g.objects.push(base);
    g.createHealthBar(base);

    this._teamEconomy.set(teamId, {
      teamId,
      baseEntityId: id,
      baseHome: pos.clone(),
      baseRadius: this._economyCfg.baseRadius * ws,
      coin: 210,
      gem: 90,
      upgrades: { speed: 0, damage: 0, hp: 0, cargo: 0 },
      mult: { speed: 1, damage: 1, hp: 1, cargo: 1 },
      nextSpendAtSec: 1.5 + Math.random() * 1.4,
      nextSpawnAtSec: 2.6 + Math.random() * 1.6,
      reinforcementCap: 36
    });
  }

  _updateTeamEconomy(nowSec) {
    const g = this.game;
    for (const [teamId, eco] of this._teamEconomy) {
      if (!eco) continue;
      if (!eco.baseEntityId || !g.world.objectMeta.has(eco.baseEntityId)) {
        if ((eco.nextRespawnAtSec ?? 0) <= nowSec) {
          this._respawnTeamBase(teamId, eco, nowSec);
        }
        continue;
      }
      if ((eco.nextSpendAtSec ?? 0) <= nowSec) {
        this._tryBuyTeamUpgrade(eco);
        eco.nextSpendAtSec = nowSec + this._randRange(this._economyCfg.spendEverySec);
      }
      if ((eco.nextSpawnAtSec ?? 0) <= nowSec) {
        this._trySpawnReinforcement(eco);
        eco.nextSpawnAtSec = nowSec + this._randRange(this._economyCfg.spawnEverySec);
      }
    }
  }

  _respawnTeamBase(teamId, eco, nowSec) {
    const g = this.game;
    const home = eco.baseHome?.clone?.() ?? new THREE.Vector3((teamId === 0 ? -2200 : 2200) * (g.worldScale ?? 1), 0, (teamId === 0 ? -1200 : 1200) * (g.worldScale ?? 1));
    this._createTeamEconomy(teamId, home.multiplyScalar(1 / (g.worldScale ?? 1)));
    const fresh = this._teamEconomy.get(teamId);
    if (!fresh) return;
    fresh.coin = Math.max(fresh.coin, Math.floor((eco.coin ?? 0) * 0.45));
    fresh.gem = Math.max(fresh.gem, Math.floor((eco.gem ?? 0) * 0.45));
    fresh.upgrades = { ...(eco.upgrades ?? fresh.upgrades) };
    fresh.mult = { ...(eco.mult ?? fresh.mult) };
    fresh.nextSpendAtSec = nowSec + 1.8;
    fresh.nextSpawnAtSec = nowSec + 3.2;
  }

  _tryBuyTeamUpgrade(eco) {
    const priorities = ['damage', 'speed', 'hp', 'cargo'];
    priorities.sort((a, b) => (eco.upgrades[a] ?? 0) - (eco.upgrades[b] ?? 0));

    for (const key of priorities) {
      const lvl = eco.upgrades[key] ?? 0;
      if (lvl >= this._economyCfg.maxUpgrades) continue;
      const coinCost = this._economyCfg.upgradeCosts[key]?.coin?.[lvl] ?? Infinity;
      const gemCost = this._economyCfg.upgradeCosts[key]?.gem?.[lvl] ?? Infinity;
      if ((eco.coin ?? 0) < coinCost || (eco.gem ?? 0) < gemCost) continue;

      eco.coin -= coinCost;
      eco.gem -= gemCost;
      eco.upgrades[key] = lvl + 1;
      this._recomputeTeamMultipliers(eco);
      return;
    }
  }

  _recomputeTeamMultipliers(eco) {
    const lv = eco.upgrades ?? {};
    eco.mult = {
      speed: 1 + (lv.speed ?? 0) * 0.08,
      damage: 1 + (lv.damage ?? 0) * 0.12,
      hp: 1 + (lv.hp ?? 0) * 0.14,
      cargo: 1 + (lv.cargo ?? 0) * 0.18
    };
  }

  _trySpawnReinforcement(eco) {
    const g = this.game;
    const living = this._countLivingTeamShips(eco.teamId);
    if (living >= eco.reinforcementCap) return;

    const lowBank = (eco.coin ?? 0) < 110 || (eco.gem ?? 0) < 10;
    if (lowBank) return;

    const choices = ['enemy_tank', 'enemy_striker', 'enemy_scout'];
    if (living < 10) choices.unshift('enemy_scout');

    for (const kind of choices) {
      const cost = this._economyCfg.reinforcementCosts[kind];
      if (!cost) continue;
      if ((eco.coin ?? 0) < cost.coin || (eco.gem ?? 0) < cost.gem) continue;
      eco.coin -= cost.coin;
      eco.gem -= cost.gem;
      this._spawnEnemyUnit(kind, eco.teamId);
      return;
    }
  }

  _countLivingTeamShips(teamId) {
    let count = 0;
    for (const [, state] of this._enemyState) {
      if ((state?.teamId ?? -1) === teamId) count++;
    }
    return count;
  }

  _tryDepositCargo(entityId, obj, state, nowSec) {
    const g = this.game;
    const eco = this._teamEconomy.get(state.teamId ?? 0);
    if (!eco || !eco.baseEntityId) return;
    if ((state.cargoUsed ?? 0) <= 0) return;
    if (!obj?.userData?.cargoManifest?.length) return;

    const bt = g.world.transform.get(eco.baseEntityId);
    if (!bt) return;

    const dx = obj.position.x - bt.x;
    const dy = obj.position.y - bt.y;
    const dz = obj.position.z - bt.z;
    const depositR = (this._economyCfg.depositRadius * (g.worldScale ?? 1));
    if (dx * dx + dy * dy + dz * dz > depositR * depositR) return;

    for (const item of obj.userData.cargoManifest) {
      if (!item) continue;
      if (item.type === 'gem') eco.gem += Math.max(1, Math.round(item.value ?? 1));
      else if (item.type === 'powerup') eco.gem += 16;
      else eco.coin += Math.max(1, Math.round(item.value ?? 1));
    }
    obj.userData.cargoManifest.length = 0;
    state.cargoUsed = 0;
    state.modeUntilSec = nowSec;
  }

  _findTeamByBaseEntity(entityId) {
    for (const [teamId, eco] of this._teamEconomy) {
      if ((eco?.baseEntityId ?? null) === entityId) return teamId;
    }
    return null;
  }

  _randRange(range) {
    const min = range?.[0] ?? 1;
    const max = range?.[1] ?? min;
    return min + Math.random() * Math.max(0.0001, max - min);
  }

  _updateEnemyTarget(entityId, state, nowSec) {
    const g = this.game;
    if ((state.nextRetargetAtSec ?? 0) > nowSec) return;
    state.nextRetargetAtSec = nowSec + 0.35 + Math.random() * 0.55;

    const t = g.world.transform.get(entityId);
    if (!t) return;
    const selfMeta = g.world.objectMeta.get(entityId);
    if (!selfMeta) return;

    const enemyObj = g.renderRegistry.get(entityId);
    const recentlyHit = ((enemyObj?.userData?.lastHitByPlayerAtSec ?? -999) + 6) > nowSec;
    const carryingCargo = (state.cargoUsed ?? 0) > 0;
    const cargoFillRatio = (state.cargoMax ?? 1) > 0 ? (state.cargoUsed ?? 0) / Math.max(1, state.cargoMax ?? 1) : 0;
    const hp = g.world.getHealth(entityId);
    const hpRatio = hp && hp.maxHp > 0 ? hp.hp / hp.maxHp : 1;
    const selfPower = this._estimateEnemyPower(entityId, selfMeta, hpRatio, state);
    if ((state.modeUntilSec ?? 0) <= nowSec) {
      const combatBias = state.combatBias ?? (this._preset.combatBias ?? 0.55);
      const preferFarm = Math.random() >= combatBias || Math.random() < (state.farmBias ?? 0.5);
      state.objectiveMode = preferFarm ? 'farm' : 'combat';
      const modeDurMul = state.modeDurationMul ?? 1;
      state.modeUntilSec = nowSec + (3.5 + Math.random() * 5.5) * modeDurMul;
    }
    let best = null;

    if (carryingCargo && cargoFillRatio >= 0.34) {
      const eco = this._teamEconomy.get(state.teamId ?? 0);
      const baseId = eco?.baseEntityId ?? null;
      const bt = baseId ? g.world.transform.get(baseId) : null;
      if (baseId && bt) {
        const dx = bt.x - t.x;
        const dy = bt.y - t.y;
        const dz = bt.z - t.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const urgency = 0.9 + cargoFillRatio * 1.2 + (hpRatio < 0.5 ? 0.5 : 0);
        best = {
          targetId: baseId,
          targetKind: 'ally_base',
          score: urgency - Math.min(1.2, Math.sqrt(d2) / 2200),
          ratio: 1,
          dist2: d2
        };
      }
    }

    if (g.playerEntityId) {
      const pt = g.world.transform.get(g.playerEntityId);
      if (pt) {
        const dx = pt.x - t.x;
        const dy = pt.y - t.y;
        const dz = pt.z - t.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const targetPower = this._estimatePlayerPower();
        const ratio = selfPower / Math.max(0.1, targetPower);
        const distNorm = Math.min(1, Math.sqrt(d2) / 1800);
        const bravery = state.aggression - state.caution * (ratio < 1 ? 0.55 : 0.15);
        const modeBoost = state.objectiveMode === 'combat' ? 0.35 : -0.12;
        const score = 1.0 + modeBoost + bravery * 0.35 - distNorm * 0.55 + (recentlyHit ? 0.3 : 0) + (Math.random() - 0.5) * 0.18 * state.unpredictability;
        if (!best || score > best.score) {
          best = {
            targetId: g.playerEntityId,
            targetKind: 'player',
            score,
            ratio,
            dist2: d2
          };
        }
      }
    }

    for (const [otherId, meta] of g.world.objectMeta) {
      if (otherId === entityId || meta?.type !== 'enemy') continue;
      const otherState = this._enemyState.get(otherId);
      if (!otherState) continue;
      if ((otherState.teamId ?? 0) === (state.teamId ?? 0)) continue;
      const ot = g.world.transform.get(otherId);
      if (!ot) continue;
      const dx = ot.x - t.x;
      const dy = ot.y - t.y;
      const dz = ot.z - t.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 2400 * 2400) continue;
      const oh = g.world.getHealth(otherId);
      const oHpRatio = oh && oh.maxHp > 0 ? oh.hp / oh.maxHp : 1;
      const targetPower = this._estimateEnemyPower(otherId, meta, oHpRatio, otherState);
      const ratio = selfPower / Math.max(0.1, targetPower);
      const distNorm = Math.min(1, Math.sqrt(d2) / 1600);
      const modeBoost = state.objectiveMode === 'combat' ? 0.2 : -0.08;
      const score = 0.9 + modeBoost + state.aggression * 0.28 - state.caution * (ratio < 1 ? 0.32 : 0.1) - distNorm * 0.52 + (Math.random() - 0.5) * 0.24 * state.unpredictability;
      if (!best || score > best.score) {
        best = {
          targetId: otherId,
          targetKind: 'enemy',
          score,
          ratio,
          dist2: d2
        };
      }
    }

    for (const [otherId, meta] of g.world.objectMeta) {
      if (!meta || meta.type !== 'enemy_base') continue;
      const baseTeamId = this._findTeamByBaseEntity(otherId);
      if (baseTeamId == null) continue;
      if (baseTeamId === (state.teamId ?? 0)) continue;
      const ot = g.world.transform.get(otherId);
      if (!ot) continue;
      const dx = ot.x - t.x;
      const dy = ot.y - t.y;
      const dz = ot.z - t.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 3500 * 3500) continue;
      const ratio = selfPower / Math.max(0.1, 18 + (this._teamEconomy.get(baseTeamId)?.mult?.hp ?? 1) * 32);
      const modeBoost = state.objectiveMode === 'combat' ? 0.38 : -0.16;
      const score = 0.65 + modeBoost + state.aggression * 0.22 - state.caution * (ratio < 1 ? 0.42 : 0.08) - Math.min(1.1, Math.sqrt(d2) / 1900);
      if (!best || score > best.score) {
        best = {
          targetId: otherId,
          targetKind: 'enemy_base',
          score,
          ratio,
          dist2: d2
        };
      }
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

    const currentValid = state.targetEntityId && g.world.objectMeta.has(state.targetEntityId);
    if (currentValid && (state.commitUntilSec ?? 0) > nowSec) return;

    if (best && best.targetId != null) {
      state.targetEntityId = best.targetId;
      state.targetKind = best.targetKind;
      state.targetPowerRatio = best.ratio;
      const fleeScale = state.fleeThresholdMul ?? (this._preset.fleeThresholdMul ?? 1);
      const forceReturn = best.targetKind === 'ally_base';
      const fleeLikely = !forceReturn && (best.ratio < ((0.92 - 0.22 * state.aggression) * fleeScale) || (hpRatio < 0.28 * fleeScale));
      state.intent = fleeLikely ? 'flee' : 'fight';
      const baseCommit = fleeLikely ? 0.45 : 0.85;
      const commitMul = state.commitDurationMul ?? 1;
      state.commitUntilSec = nowSec + (baseCommit + Math.random() * 0.9) * commitMul;
      return;
    }

    if (objTarget && objDist < 2800 * 2800) {
      state.targetEntityId = objTarget;
      state.targetKind = 'object';
      state.targetPowerRatio = 1;
      state.intent = 'farm';
      const commitMul = state.commitDurationMul ?? 1;
      state.commitUntilSec = nowSec + (0.6 + Math.random() * 0.8) * commitMul;
      return;
    }

    state.targetEntityId = null;
    state.targetKind = null;
    state.intent = 'wander';
    state.targetPowerRatio = 1;
    state.commitUntilSec = nowSec + 0.25;
  }

  _updateBehaviorState(state, {
    nowSec,
    dist,
    stopDist,
    shotRange,
    hpRatio,
    playerHullRatio,
    recentlyHit,
    targetIsPlayer
  }) {
    if ((state.nextStrafeFlipAtSec ?? 0) <= nowSec) {
      state.strafeDir = (state.strafeDir ?? 1) * -1;
      state.nextStrafeFlipAtSec = nowSec + 0.8 + Math.random() * 1.4;
    }

    const intent = state.intent ?? 'fight';
    const ratio = state.targetPowerRatio ?? 1;

    let behavior = 'strafe';
    const fleeScale = state.fleeThresholdMul ?? (this._preset.fleeThresholdMul ?? 1);
    if (intent === 'flee' || hpRatio < (0.28 * fleeScale)) {
      behavior = 'flee';
    } else if (state.targetKind === 'ally_base') {
      behavior = dist > stopDist * 0.95 ? 'chase' : 'strafe';
    } else if (!targetIsPlayer && state.targetKind === 'object') {
      behavior = dist > stopDist * 1.15 ? 'chase' : 'strafe';
    } else if (ratio > (1.08 - state.aggression * 0.12) && dist < stopDist * 1.6) {
      behavior = dist < stopDist * 0.9 ? 'pressure' : 'chase';
    } else if (ratio < (0.98 + state.caution * 0.12)) {
      behavior = dist < stopDist * 1.25 ? 'kite' : 'evade';
    } else if (recentlyHit && hpRatio < 0.62) {
      behavior = 'evade';
    } else if (dist > shotRange * 1.08) {
      behavior = 'chase';
    } else if (dist < stopDist * 0.78) {
      behavior = hpRatio > (playerHullRatio + 0.12) ? 'pressure' : 'kite';
    } else if (playerHullRatio < 0.45 && hpRatio > 0.52) {
      behavior = 'pressure';
    } else {
      behavior = 'strafe';
    }
    state.behavior = behavior;
    return behavior;
  }

  _estimateEnemyPower(entityId, meta, hpRatio, state) {
    const cfg = V1.targets?.[meta?.kind]?.enemy ?? {};
    const eco = this._teamEconomy.get(state?.teamId ?? -1);
    const dmg = (cfg.shotDamage ?? 6) * (eco?.mult?.damage ?? 1);
    const cd = Math.max(0.2, cfg.shotCooldownSec ?? 2);
    const pressure = dmg / cd;
    const mobility = ((cfg.moveSpeed ?? 6) * (eco?.mult?.speed ?? 1)) + (cfg.strafe ?? 0) * 0.8;
    const aggression = 0.9 + (state?.aggression ?? 1) * 0.25;
    return pressure * 0.65 + mobility * 0.42 + (hpRatio * 18 * (eco?.mult?.hp ?? 1)) * aggression;
  }

  _estimatePlayerPower() {
    const g = this.game;
    const maxHull = Math.max(1, g.shipDerived?.maxHull ?? 100);
    const hullRatio = Math.max(0, Math.min(1, (g.stats?.hull ?? maxHull) / maxHull));
    const dmg = g.weaponDerived?.damage ?? 10;
    const fireRateMs = Math.max(120, g.weaponDerived?.fireRateMs ?? 600);
    const dps = dmg * (1000 / fireRateMs);
    const speed = (g.shipData?.speed ?? 1) * 8;
    return dps * 0.8 + speed * 0.5 + hullRatio * 24;
  }

  _collectNearbyLoot(entityId, obj, state) {
    const g = this.game;
    if ((state.cargoUsed ?? 0) >= (state.cargoMax ?? 0)) return;

    const pickupRadius = (g.worldScale ?? 1) * 28;
    const pickupR2 = pickupRadius * pickupRadius;

    for (const [lootId, meta] of g.world.loot) {
      if ((state.cargoUsed ?? 0) >= (state.cargoMax ?? 0)) break;
      if (meta?.noCargo) continue;
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

  _shootEnemy(ownerEntityId, ownerObj, bulletSpeed, targetEntityId, distToTarget, shotRange, shotDamage) {
    const g = this.game;
    if (!targetEntityId || !g.scene) return;
    const tt = g.world.transform.get(targetEntityId);
    if (!tt) return;

    this._from.copy(ownerObj.position);
    this._to.set(tt.x, tt.y, tt.z);
    const dir = this._to.sub(this._from).normalize();

    const missScaleBase = Math.max(0.006, 0.045 * (distToTarget / Math.max(1, shotRange)));
    const ownerState = this._enemyState.get(ownerEntityId);
    const missScale = missScaleBase * (ownerState?.missMul ?? (this._preset.missMul ?? 1));
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
      targetEntityId,
      shotDamage: Math.max(1, shotDamage ?? 1)
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
        const dmg = Math.max(1, bullet.shotDamage ?? V1.targets?.[owner?.kind]?.enemy?.shotDamage ?? 6);
        g.applyShipDamage(dmg);
        g.vfx.createHitEffect(new THREE.Vector3(pt.x, pt.y, pt.z));
        return true;
      }
    }

    const ownerMeta = bullet.ownerEntityId ? g.world.objectMeta.get(bullet.ownerEntityId) : null;
    const ownerState = bullet.ownerEntityId ? this._enemyState.get(bullet.ownerEntityId) : null;
    for (const [entityId, meta] of g.world.objectMeta) {
      if (meta?.type !== 'enemy' && meta?.type !== 'enemy_base') continue;
      if (entityId === bullet.ownerEntityId) continue;
      const targetState = this._enemyState.get(entityId);
      if (meta?.type === 'enemy') {
        if (ownerState && targetState && ownerState.teamId === targetState.teamId) continue;
      } else if (meta?.type === 'enemy_base') {
        const baseTeam = this._findTeamByBaseEntity(entityId);
        if (baseTeam != null && ownerState && baseTeam === (ownerState.teamId ?? -1)) continue;
      }
      const t = g.world.transform.get(entityId);
      if (!t) continue;
      const obj = g.renderRegistry.get(entityId);
      const hitR = obj?.userData?.hitRadius ?? (12 * (g.worldScale ?? 1));
      const r = Math.max(6 * (g.worldScale ?? 1), (t.sx ?? 1) * 0.5, hitR);
      const dx = bullet.x - t.x;
      const dy = bullet.y - t.y;
      const dz = bullet.z - t.z;
      if (dx * dx + dy * dy + dz * dz > r * r) continue;

      const dmg = Math.max(1, bullet.shotDamage ?? V1.targets?.[ownerMeta?.kind]?.enemy?.shotDamage ?? 6);
      const h = g.world.damage(entityId, dmg);
      g.vfx.createHitEffect(new THREE.Vector3(bullet.x, bullet.y, bullet.z));
      if (obj?.userData?.healthBar) {
        obj.userData.healthBar.sprite.visible = true;
        g.updateHealthBar(obj);
      }
      if (h && h.hp <= 0) g.destroyObjectEntity(entityId);
      return true;
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
      const dmg = Math.max(1, bullet.shotDamage ?? V1.targets?.[owner?.kind]?.enemy?.shotDamage ?? 6);
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
