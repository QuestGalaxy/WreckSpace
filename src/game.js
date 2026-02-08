import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SoundManager } from './soundManager.js';
import { FixedTimestepLoop } from './core/fixedTimestepLoop.js';
import { KeyboardInput } from './input/keyboard.js';
import { CombatSystem } from './game/systems/combatSystem.js';
import { LootSystem } from './game/systems/lootSystem.js';
import { MovementSystem } from './game/systems/movementSystem.js';
import { CameraSystem } from './game/systems/cameraSystem.js';
import { NavigationSystem } from './game/systems/navigationSystem.js';
import { EnvironmentSystem } from './game/systems/environmentSystem.js';
import { VfxSystem } from './game/systems/vfxSystem.js';
import { SpawnSystem } from './game/systems/spawnSystem.js';
import { VoxelDestructionSystem } from './game/systems/voxelDestructionSystem.js';
import { World } from './game/world/world.js';
import { RenderRegistry } from './render/syncFromWorld.js';
import { addBox, addSphere, buildVoxelSurfaceGeometry, mulberry32 } from './render/voxel.js';
import { createVoxelTextures } from './render/voxelTextures.js';
import { createVoxelShipModel } from './render/voxelShipFactory.js';
import { V1 } from './balance/v1.js';

function _key3(x, y, z) {
    return `${x},${y},${z}`;
}

function _computeSurfaceKeys(filled) {
    const dirs = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1]
    ];
    const out = [];
    for (const k of filled) {
        const [xs, ys, zs] = k.split(',');
        const x = Number(xs);
        const y = Number(ys);
        const z = Number(zs);
        let surf = false;
        for (const [dx, dy, dz] of dirs) {
            if (!filled.has(_key3(x + dx, y + dy, z + dz))) {
                surf = true;
                break;
            }
        }
        if (surf) out.push(k);
    }
    return out;
}

function _sampleFromArray(arr, count, rng = Math.random) {
    const n = Math.min(count, arr.length);
    // Partial Fisher-Yates shuffle into first n entries.
    const a = arr.slice();
    for (let i = 0; i < n; i++) {
        const j = i + Math.floor(rng() * (a.length - i));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
    }
    return a.slice(0, n);
}

export class Game {
    /**
     * @param {any} shipData
     * @param {{ hud?: import('./ui/hudController.js').HudController, mode?: 'main'|'testArea' }} [deps]
     */
    constructor(shipData, deps = {}) {
        this.shipData = shipData;
        this.soundManager = new SoundManager();
        this.hud = deps.hud ?? null;
        this.mode = deps.mode ?? 'main';
        // Hit feedback profile:
        // - 'cinematic' matches the tuned Test Area feel (louder hit audio, more sparks/glow, more chunks).
        // - 'subtle' is lighter for performance/clarity in crowded scenes.
        this.hitFeedbackProfile = deps.hitFeedbackProfile ?? 'cinematic';
        this.canvas = document.getElementById('game-canvas');
        
        // V1 state
        this.stats = {
            coin: 0,
            gem: 0,
            cargoUsed: 0,
            hull: shipData.hull,
            shield: 0
        };

        // Progression (session-only)
        this.shipUpgrades = { speed: 0, hull: 0, cargo: 0, warp: 0 };
        this.weaponUpgrades = { damage: 0, fireRate: 0 };
        this.weaponLevelTier = 1; // 1..3
        /** @type {(null | string)[]} */
        this.addonSlots = Array(V1.addons.slots).fill(null); // ids, stackable by duplicates
        /** @type {Record<string, number>} */
        this.powerupsActive = {}; // id -> expiresAtSec

        // Warp cooldown tracking
        this.warpReadyAtSec = 0;
        this.warpLastAtSec = -1e9;

        // Derived (recomputed from balance + progression)
        this.shipDerived = { speedMul: 1, maxHull: shipData.hull, cargoMax: shipData.cargo, warpCooldownSec: shipData.warpCooldownSec };
        this.weaponDerived = { damage: V1.weapon.baseDamage, fireRateMs: V1.weapon.baseFireRateMs };
        this.magnetDerived = { range: 0 };
        this.shieldDerived = { max: 0, regenPerSec: 0 };
        this.powerupDerived = { damageMul: 1, speedMul: 1, fireRateMul: 1, magnetRangeMul: 1, bonusShieldMax: 0 };
        
        this.input = new KeyboardInput();
        this.keys = this.input.keys;
        this.objects = [];
        this.bullets = [];
        this.particles = [];
        this.cameraShake = 0;
        this.isPaused = false;
        this.lastShotTime = 0;

        if (this.hud) {
            this.hud.setStats(this._getHudStats());
            this.hud.onResume(() => this.resumeFromBase());
            this.hud.onUpgradeShipStat((statId) => this.upgradeShipStat(statId));
            this.hud.onUpgradeWeaponAttr((attrId) => this.upgradeWeaponAttr(attrId));
            this.hud.onCraftWeaponLevel(() => this.craftWeaponLevel());
            this.hud.onBuyAddon((addonId) => this.buyAddon(addonId));
            this.hud.setBaseMenuVisible(false);
        }

        this._loop = new FixedTimestepLoop({ stepHz: 60, maxSubSteps: 5 });
        this._simTimeSec = 0;

        this.world = new World();
        this.renderRegistry = new RenderRegistry();

        this.combat = new CombatSystem(this);
        this.loot = new LootSystem(this);
        this.movement = new MovementSystem(this);
        this.cameraSystem = new CameraSystem(this);
        this.navigation = new NavigationSystem(this);
        this.environment = new EnvironmentSystem(this);
        this.vfx = new VfxSystem(this);
        this.spawner = new SpawnSystem(this);
        this.voxelDestruction = new VoxelDestructionSystem(this);

        /** @type {{ kind: 'base' | 'planet', target: any, sprite: THREE.Sprite, yOffset: number, prefix: string, lastText: string, baseScale: THREE.Vector3 }[]} */
        this.distanceLabelTargets = [];

        /** @type {number|null} */
        this.currentTargetEntityId = null;

        /** @type {number|null} */
        this.playerEntityId = null;

        // When a locked target is destroyed, briefly suppress re-lock so the crosshair snaps back.
        this._lockSuppressUntilSec = 0;

        // Cruise "gear" / throttle. MovementSystem reads this and lerps toward it.
        this.throttle = { level: 3, min: 0, max: 10, step: 1 };

        // Visual direction: voxel / Minecraft-ish space.
        this.visual = { mode: 'voxel' };
        this.voxel = {
            // World-units per voxel. 1.0 was reading a bit "LEGO micro";
            // bumping this makes the blockiness more obvious.
            size: 5.0
        };
        // Used for scaling legacy "world numbers" (ranges, speeds) tuned before voxel changes.
        this.worldScale = this.voxel.size / 2.0;

        // Single theme/palette for now; later this can be per-world.
        this.theme = {
            // Slightly lifted, more saturated deep-space so silhouettes read.
            sky: 0x101a3a,
            fog: 0x0b1533,
            // Rock range (slightly brighter + warmer variety so asteroids don't read as the same gray blob).
            asteroidPalette: [
                0x9aa6b2, // light slate
                0x7f8c99, // steel
                0x8e7b6a, // warm stone
                0x6f7f86, // blue gray
                0x7a6e63, // brown gray
                0x6f8a7d  // mossy gray
            ],
            station: { hull: 0xa6adb8, dark: 0x1b1f2a, light: 0x66ccff },
            ship: { dark: 0x1b1f2a, accent: 0xffaa22, glass: 0x0b1222, thruster: 0x66ccff }
        };

        // Initialize derived stats and UI state.
        this.recomputeDerivedStats();
        this.stats.hull = this.shipDerived.maxHull;
        this.stats.shield = this.shieldDerived.max;
        this.updateHudStats();
    }

    init() {
        const isTestArea = this.mode === 'testArea';

        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = this._createSpaceBackgroundTexture(isTestArea ? 1024 : 768);
        // Keep fog subtle; helps distant voxels read without looking realistic.
        // Slightly stronger haze improves depth in space without becoming "smoky".
        this.scene.fog = new THREE.FogExp2(this.theme.fog, (isTestArea ? 0.00032 : 0.00022) / this.worldScale);

        // Camera setup - Reduced FOV to 60 for less distortion
        this.camera = new THREE.PerspectiveCamera(isTestArea ? 55 : 60, window.innerWidth / window.innerHeight, 0.1, (isTestArea ? 2400 : 5000) * this.worldScale);
        
        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            // Voxel edges benefit from AA (less shimmering).
            antialias: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        // Clamp DPR a bit; voxel scenes can get vertex-heavy quickly.
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        // Lift mids a bit; helps voxel readability without cranking lights.
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = isTestArea ? 1.34 : 1.28;

        // Post-processing
        const renderScene = new RenderPass(this.scene, this.camera);
        
        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            isTestArea ? 1.05 : 0.75, // strength
            isTestArea ? 0.22 : 0.18, // radius
            isTestArea ? 0.22 : 0.35  // threshold (mostly glows)
        );
        
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(renderScene);
        this.composer.addPass(bloomPass);

        // Lighting
        // Minecraft-ish: simple ambient + key + faint rim.
        // Ambient is intentionally a bit high; Minecraft-like face shading provides the depth.
        const ambientLight = new THREE.AmbientLight(0x9fb7ff, isTestArea ? 1.05 : 1.25);
        this.scene.add(ambientLight);

        // Soft "sky vs void" fill improves depth cues (tops read lighter than undersides).
        const hemi = new THREE.HemisphereLight(0xd6ecff, 0x080518, isTestArea ? 0.90 : 0.75);
        this.scene.add(hemi);
        
        const sunLight = new THREE.DirectionalLight(isTestArea ? 0xfff6e8 : 0xffffff, isTestArea ? 1.45 : 1.2);
        sunLight.position.set(120, 160, 90);
        this.scene.add(sunLight);

        const rim = new THREE.DirectionalLight(0x66ccff, isTestArea ? 0.55 : 0.35);
        rim.position.set(-120, 20, -180);
        this.scene.add(rim);

        // Camera fill light: prevents "pitch black" faces when the main key is behind.
        // Attach to camera so it always helps what's on screen without flattening everything.
        this.scene.add(this.camera);
        const camFill = new THREE.PointLight(0x9fd9ff, isTestArea ? 0.75 : 0.55, 900 * this.worldScale, 2);
        camFill.position.set(0, 0, 0);
        this.camera.add(camFill);

        this._initVoxelTextures();

        // Backdrop
        if (!isTestArea) {
            this.createRetroBackdrop(); // starfield + nebula sprites
            this.createSpaceDust(); // speed feel; CRT pass stylizes it
        }

        // Base Station (main world only)
        if (!isTestArea) this.createBaseStation();

        // Player Spaceship
        this.createPlayerShip();

        // Environment (Asteroids/Planets)
        if (isTestArea) {
            // Camera tuning for a tighter, more "tactile" scene.
            this.cameraConfig = {
                offsetZ: -26,
                offsetY: 18,
                lookY: 5.0,
                lookZ: 70,
                fov: 55,
                boostFov: 66,
                follow: 0.11
            };

            if (this.hud?.setControlsHint) {
                this.hud.setControlsHint('WASD: Drive | 2x UP/DOWN: Speed | Z: Boost | SPACE: Fire');
            }
            if (this.hud?.setBaseMarkerVisible) this.hud.setBaseMarkerVisible(false);

            this.createTestAreaEnvironment();
        } else {
            this.createEnvironment();
        }

        // Controls
        this.input.attach(window);
        this._onKeyDown = (e) => {
            if (e.code === 'Space') this.shoot();
            else if (e.code === 'KeyF') this.tryWarpToBase();
        };
        window.addEventListener('keydown', this._onKeyDown);
        this._onResize = () => this.onWindowResize();
        window.addEventListener('resize', this._onResize);
        this._onMouseDown = () => this.shoot();
        window.addEventListener('mousedown', this._onMouseDown);

        // Start Loop
        requestAnimationFrame((t) => this.animate(t));
    }

    createVoxelBulletMesh() {
        const vox = this.voxel?.size ?? 1;
        const geo = new THREE.BoxGeometry(vox, vox, vox);
        const mat = new THREE.MeshStandardMaterial({
            color: this.theme?.ship?.accent ?? 0xffaa22,
            map: this._voxelTextures?.panels ?? null,
            emissive: 0x66ccff,
            emissiveIntensity: 0.35,
            metalness: 0.05,
            roughness: 0.55,
            flatShading: true
        });
        const m = new THREE.Mesh(geo, mat);
        // A tiny halo so it reads even against bright debris.
        const glowGeo = new THREE.BoxGeometry(vox * 1.9, vox * 1.9, vox * 1.9);
        const glowMat = new THREE.MeshBasicMaterial({
            color: 0x66ccff,
            transparent: true,
            opacity: 0.18,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        m.add(new THREE.Mesh(glowGeo, glowMat));
        return m;
    }

    createTestAreaEnvironment() {
        const ws = this.worldScale ?? 1;

        // A small, controlled scene: 1 planet + 1 asteroid, placed for quick interaction.
        // Planet: mid distance, large enough to read voxel carving.
        const planetPos = new THREE.Vector3(0, 0, 520 * ws);
        const asteroidPos = new THREE.Vector3(120 * ws, 20 * ws, 240 * ws);
        this._testAreaCfg = { planetPos, asteroidPos };

        // Pre-bake variants (reuse the same caches as the main world).
        if (!this._voxelAsteroidVariants) {
            this._voxelAsteroidVariants = [];
            for (let i = 0; i < 16; i++) {
                const rng = mulberry32(0xdecafbad + i * 1013);
                const filled = new Set();
                const r = 2 + Math.floor(rng() * 6); // 2..7 voxels
                addSphere(filled, r, { hollow: false, jitter: 1.25, rng });
                for (const k of Array.from(filled)) {
                    if (rng() < 0.10) filled.delete(k);
                }
                const geo = buildVoxelSurfaceGeometry(filled, {
                    voxelSize: this.voxel.size,
                    shadeTop: 1.0,
                    shadeSide: 0.92,
                    shadeBottom: 0.78
                });
                geo.computeBoundingSphere();
                const br = geo.boundingSphere?.radius ?? 1;
                const normScale = br > 0.00001 ? 1 / br : 1;
                if (normScale !== 1) geo.scale(normScale, normScale, normScale);
                geo.computeBoundingSphere();
                this._voxelAsteroidVariants.push({
                    geo,
                    filled,
                    voxelSizeOriginal: this.voxel.size,
                    normScale,
                    shadeTop: 1.0,
                    shadeSide: 0.92,
                    shadeBottom: 0.78
                });
            }
        }

        // Share the same planet variants across modes, but ensure the bake uses world-UVs.
        // This avoids per-voxel noisy tiling and keeps planet patterns consistent.
        const wantPlanetUvMode = 'world';
        const wantPlanetUvScale = 0.09;
        if (!this._voxelPlanetVariants || this._voxelPlanetVariantsUvMode !== wantPlanetUvMode || this._voxelPlanetVariantsUvScale !== wantPlanetUvScale) {
            this._voxelPlanetVariants = [];
            for (let i = 0; i < 4; i++) {
                const rng = mulberry32(0x12345678 + i * 99991);
                const filled = new Set();
                const r = 11 + Math.floor(rng() * 3); // 11..13 voxels
                addSphere(filled, r, { hollow: true, thickness: 2, jitter: 0.75, rng });
                const geo = buildVoxelSurfaceGeometry(filled, { voxelSize: 1.0, uvMode: wantPlanetUvMode, uvScale: wantPlanetUvScale });
                geo.computeBoundingSphere();
                const br = geo.boundingSphere?.radius ?? 1;
                const normScale = br > 0.00001 ? 1 / br : 1;
                if (normScale !== 1) geo.scale(normScale, normScale, normScale);
                geo.computeBoundingSphere();
                this._voxelPlanetVariants.push({ geo, filled, voxelSizeOriginal: 1.0, normScale });
            }
            this._voxelPlanetVariantsUvMode = wantPlanetUvMode;
            this._voxelPlanetVariantsUvScale = wantPlanetUvScale;
        }

        this._spawnTestAreaAsteroid();
        this._spawnTestAreaPlanet();
    }

    _spawnTestAreaAsteroid() {
        const ws = this.worldScale ?? 1;
        const pos = this._testAreaCfg?.asteroidPos ?? new THREE.Vector3(120 * ws, 20 * ws, 240 * ws);

        const variant = this._voxelAsteroidVariants[0];
        const baseColor = new THREE.Color(this.theme.asteroidPalette[1] ?? 0x7f8c99);
        const material = this._voxLit({
            color: baseColor,
            map: this._voxelTextures.rock,
            emissive: baseColor.clone().multiplyScalar(0.10),
            emissiveIntensity: 0.18,
            roughness: 0.95,
            metalness: 0.02
        });

        const asteroid = new THREE.Mesh(variant.geo, material);
        const scale = 11.5 * ws;
        asteroid.scale.set(scale, scale, scale);
        asteroid.position.copy(pos);
        asteroid.rotation.set(0.35, 0.2, 0.0);
        asteroid.userData = { type: 'asteroid', rotationSpeed: { x: 0.002, y: -0.003, z: 0.001 }, voxel: null };

        const filled = new Set(variant.filled);
        asteroid.userData.voxel = {
            filled,
            resource: new Set(),
            resourceRate: 0,
            initialCount: filled.size,
            voxelSizeOriginal: variant.voxelSizeOriginal,
            normScale: variant.normScale,
            shadeTop: variant.shadeTop,
            shadeSide: variant.shadeSide,
            shadeBottom: variant.shadeBottom,
            lastRebuildAtSec: -999
        };

        const hp = V1.targets.asteroid_small.hp ?? 120;
        const entityId = this.world.createObject({ type: 'asteroid', kind: 'asteroid_small', hp, maxHp: hp });
        this.renderRegistry.bind(entityId, asteroid);
        this.world.transform.set(entityId, {
            x: asteroid.position.x,
            y: asteroid.position.y,
            z: asteroid.position.z,
            rx: asteroid.rotation.x,
            ry: asteroid.rotation.y,
            rz: asteroid.rotation.z,
            sx: asteroid.scale.x,
            sy: asteroid.scale.y,
            sz: asteroid.scale.z
        });
        this.world.spin.set(entityId, { x: asteroid.userData.rotationSpeed.x, y: asteroid.userData.rotationSpeed.y, z: asteroid.userData.rotationSpeed.z });

        this.createHealthBar(asteroid);
        this.scene.add(asteroid);
        this.objects.push(asteroid);

        // Local kick light to make chunks read.
        const light = new THREE.PointLight(0x66ccff, 1.1, 260 * ws, 2);
        light.position.copy(pos).add(new THREE.Vector3(25 * ws, 18 * ws, 40 * ws));
        this.scene.add(light);

        return entityId;
    }

    _spawnTestAreaPlanet() {
        const ws = this.worldScale ?? 1;
        const pos = this._testAreaCfg?.planetPos ?? new THREE.Vector3(0, 0, 520 * ws);

        const variant = this._voxelPlanetVariants[1];
        const color = 0x3366ff;
        const mat = this._voxLit({
            color,
            // Test area: use the same planet surface pattern as the main world.
            map: this._voxelTextures.rockBlob ?? this._voxelTextures.rockSoft ?? this._voxelTextures.rock,
            emissive: 0x000000,
            emissiveIntensity: 0.0
        });
        mat.roughness = 0.98;
        mat.metalness = 0.0;
        const planet = new THREE.Mesh(variant.geo, mat);
        const scale = 72 * ws;
        planet.scale.set(scale, scale, scale);
        planet.position.copy(pos);
        planet.rotation.set(0, 0, 0);
        planet.userData = { type: 'planet', voxel: null };

        const filled = new Set(variant.filled);
        planet.userData.voxel = {
            filled,
            resource: new Set(),
            resourceRate: 0,
            initialCount: filled.size,
            voxelSizeOriginal: variant.voxelSizeOriginal,
            normScale: variant.normScale,
            shadeTop: 1.0,
            shadeSide: 0.88,
            shadeBottom: 0.72,
            uvMode: 'world',
            uvScale: 0.09,
            lastRebuildAtSec: -999
        };

        const hp = V1.targets.planet_mini.hp ?? 500;
        const entityId = this.world.createObject({ type: 'planet', kind: 'planet_mini', hp, maxHp: hp });
        this.renderRegistry.bind(entityId, planet);
        this.world.transform.set(entityId, {
            x: planet.position.x,
            y: planet.position.y,
            z: planet.position.z,
            rx: planet.rotation.x,
            ry: planet.rotation.y,
            rz: planet.rotation.z,
            sx: planet.scale.x,
            sy: planet.scale.y,
            sz: planet.scale.z
        });
        this.world.spin.set(entityId, { x: 0, y: 0.0012, z: 0 });

        this.createHealthBar(planet);
        this.scene.add(planet);
        this.objects.push(planet);

        const glow = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: this.vfx.createGlowTexture('#ffffff'),
                color,
                transparent: true,
                opacity: 0.22,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            })
        );
        glow.scale.set(4.0, 4.0, 1);
        planet.add(glow);

        // Key light to emphasize depth across the carved surface.
        const light = new THREE.PointLight(0xffe8cc, 1.25, 900 * ws, 2);
        light.position.copy(pos).add(new THREE.Vector3(160 * ws, 120 * ws, -120 * ws));
        this.scene.add(light);

        return entityId;
    }

    _scheduleTestAreaRespawn(meta) {
        if (this.mode !== 'testArea') return;
        const kind = meta?.kind ?? null;
        if (kind !== 'asteroid_small' && kind !== 'planet_mini') return;

        // Avoid stacking respawns if something calls destroy twice.
        const key = kind;
        if (!this._testAreaRespawnPending) this._testAreaRespawnPending = new Set();
        if (this._testAreaRespawnPending.has(key)) return;
        this._testAreaRespawnPending.add(key);

        setTimeout(() => {
            if (this._disposed) return;
            this._testAreaRespawnPending?.delete?.(key);
            if (this.mode !== 'testArea') return;
            if (!this.scene) return;
            if (kind === 'asteroid_small') this._spawnTestAreaAsteroid();
            else if (kind === 'planet_mini') this._spawnTestAreaPlanet();
        }, 1200);
    }

    resumeFromBase() {
        if (this.hud) this.hud.setBaseMenuVisible(false);
        this.isPaused = false;
        // Refill on resume.
        this.stats.hull = this.shipDerived.maxHull;
        this.stats.shield = this.shieldDerived.max;
        this.updateHudStats();
    }

    _nowSec() {
        return this._simTimeSec ?? 0;
    }

    _getHudStats() {
        const now = this._nowSec();
        const warpLeft = Math.max(0, (this.warpReadyAtSec ?? 0) - now);
        return {
            hull: this.stats.hull,
            maxHull: this.shipDerived.maxHull,
            shield: this.stats.shield,
            maxShield: this.shieldDerived.max,
            cargoUsed: this.stats.cargoUsed,
            cargoMax: this.shipDerived.cargoMax,
            coin: this.stats.coin,
            gem: this.stats.gem,
            warpCooldownLeftSec: warpLeft
        };
    }

    isPowerupActive(id) {
        const exp = this.powerupsActive?.[id] ?? 0;
        return exp > this._nowSec();
    }

    activatePowerup(powerupId) {
        const now = this._nowSec();
        const p = Object.values(V1.powerups).find((x) => x && x.id === powerupId) ?? null;
        if (!p) return;

        if (p.id === V1.powerups.freeWarp.id) {
            this.warpReadyAtSec = now;
            this.showMessage(`${p.name}! Warp ready.`);
            return;
        }

        this.powerupsActive[p.id] = now + Math.max(0, p.durationSec ?? 0);
        this.recomputeDerivedStats();

        if (p.id === V1.powerups.instantShield.id) {
            // Fill shield to the current max (includes temporary bonus).
            this.stats.shield = this.shieldDerived.max;
        }

        this.showMessage(`${p.name}!`);
        this.updateHudStats();
    }

    recomputeDerivedStats() {
        const now = this._nowSec();

        // Powerup-derived modifiers (temporary).
        const pd = { damageMul: 1, speedMul: 1, fireRateMul: 1, magnetRangeMul: 1, bonusShieldMax: 0 };
        if (this.isPowerupActive(V1.powerups.megaMagnet.id)) pd.magnetRangeMul *= V1.powerups.megaMagnet.magnetRangeMultiplier;
        if (this.isPowerupActive(V1.powerups.damageBoost.id)) pd.damageMul *= V1.powerups.damageBoost.damageMultiplier;
        if (this.isPowerupActive(V1.powerups.overdrive.id)) {
            pd.speedMul *= V1.powerups.overdrive.speedMultiplier;
            pd.fireRateMul *= V1.powerups.overdrive.fireRateMultiplier;
        }
        if (this.isPowerupActive(V1.powerups.instantShield.id)) {
            pd.bonusShieldMax += V1.powerups.instantShield.bonusShieldMax;
        }
        this.powerupDerived = pd;

        // Ship derived.
        const su = this.shipUpgrades ?? { speed: 0, hull: 0, cargo: 0, warp: 0 };
        const sCfg = V1.shipUpgrades;

        const speedTier = Math.min(sCfg.maxTier, Math.max(0, su.speed ?? 0));
        const hullTier = Math.min(sCfg.maxTier, Math.max(0, su.hull ?? 0));
        const cargoTier = Math.min(sCfg.maxTier, Math.max(0, su.cargo ?? 0));
        const warpTier = Math.min(sCfg.maxTier, Math.max(0, su.warp ?? 0));

        const speedMul = (this.shipData.speed ?? 1) * (1 + speedTier * (sCfg.speed.deltaMul ?? 0)) * (pd.speedMul ?? 1);
        const maxHull = (this.shipData.hull ?? 0) + hullTier * (sCfg.hull.deltaFlat ?? 0);
        const cargoMax = (this.shipData.cargo ?? 0) + cargoTier * (sCfg.cargo.deltaFlat ?? 0);
        const warpCd0 = (this.shipData.warpCooldownSec ?? 10) - warpTier * (sCfg.warp.deltaSec ?? 0);
        const warpCooldownSec = Math.max(sCfg.warp.minCooldownSec ?? 0, warpCd0);

        this.shipDerived = { speedMul, maxHull, cargoMax, warpCooldownSec };

        // Weapon derived.
        const wu = this.weaponUpgrades ?? { damage: 0, fireRate: 0 };
        const wCfg = V1.weaponUpgrades;
        const dmgTier = Math.min(wCfg.maxTier, Math.max(0, wu.damage ?? 0));
        const frTier = Math.min(wCfg.maxTier, Math.max(0, wu.fireRate ?? 0));

        const baseDamage = (V1.weapon.baseDamage ?? 0) + dmgTier * (wCfg.damage.deltaFlat ?? 0);
        const fr0 = (V1.weapon.baseFireRateMs ?? 600) - frTier * (wCfg.fireRate.deltaMs ?? 0);
        const fr1 = Math.max(wCfg.fireRate.minFireRateMs ?? 1, fr0);
        const level = Math.max(1, Math.min(3, this.weaponLevelTier ?? 1));
        const levelMul = V1.weaponLevels.tiers[level]?.damageMultiplier ?? 1;

        // Apply overdrive as multiplicative "faster" (lower ms).
        const fireRateMs = Math.max(wCfg.fireRate.minFireRateMs ?? 1, Math.floor(fr1 * (pd.fireRateMul ?? 1)));
        this.weaponDerived = { damage: baseDamage * levelMul, fireRateMs };

        // Addons derived.
        const magnetStacks = this.countAddon('magnet');
        if (magnetStacks > 0 || (pd.magnetRangeMul ?? 1) > 1) {
            const base = V1.addons.magnet.baseRange ?? 0;
            const per = V1.addons.magnet.rangePerExtraStack ?? 0;
            const r = base + Math.max(0, magnetStacks - 1) * per;
            this.magnetDerived = { range: r * (this.worldScale ?? 1) * (pd.magnetRangeMul ?? 1) };
        } else {
            this.magnetDerived = { range: 0 };
        }

        const shieldStacks = this.countAddon('shield');
        const shieldMax = shieldStacks * (V1.addons.shield.maxPerStack ?? 0) + (pd.bonusShieldMax ?? 0);
        const shieldRegen = shieldStacks * (V1.addons.shield.regenPerStackPerSec ?? 0);
        this.shieldDerived = { max: shieldMax, regenPerSec: shieldRegen };

        // Clamp current values to new maxima.
        this.stats.hull = Math.max(0, Math.min(this.stats.hull ?? 0, this.shipDerived.maxHull));
        this.stats.shield = Math.max(0, Math.min(this.stats.shield ?? 0, this.shieldDerived.max));
        this.stats.cargoUsed = Math.max(0, Math.min(this.stats.cargoUsed ?? 0, this.shipDerived.cargoMax));

        void now;
    }

    countAddon(addonId) {
        let n = 0;
        for (const s of this.addonSlots ?? []) if (s === addonId) n++;
        return n;
    }

    _tickShipSystems(dtSec, nowSec) {
        // Expire powerups and recompute derived if needed.
        let changed = false;
        for (const [id, exp] of Object.entries(this.powerupsActive ?? {})) {
            if (!exp || exp <= nowSec) {
                delete this.powerupsActive[id];
                changed = true;
            }
        }
        if (changed) {
            this.recomputeDerivedStats();
        }

        // Shield regen (if any).
        if (this.shieldDerived.regenPerSec > 0 && this.stats.shield < this.shieldDerived.max) {
            this.stats.shield = Math.min(this.shieldDerived.max, this.stats.shield + this.shieldDerived.regenPerSec * dtSec);
        }

        // V1: no collision damage; damage should be applied by enemy fire (future/other system).

        if (this.stats.hull <= 0 && !this.isPaused) {
            this.showMessage('Ship Destroyed! (Reload to restart)');
            this.isPaused = true;
            if (this.hud) this.hud.setBaseMenuVisible(false);
        }
    }

    _applyCollisionDamage(dtSec) {
        if (!V1.collisionDamage?.enabled) return;
        if (!this.playerEntityId) return;

        const pt = this.world.transform.get(this.playerEntityId);
        if (!pt) return;

        const px = pt.x, py = pt.y, pz = pt.z;
        const shipR = this.shipCollisionRadiusWorld ?? (14 * (this.worldScale ?? 1));

        let dmg = 0;
        for (const [entityId, meta] of this.world.objectMeta) {
            const t = this.world.transform.get(entityId);
            if (!t) continue;
            const obj = this.renderRegistry.get(entityId);
            if (!obj) continue;
            const geoR = obj.geometry?.boundingSphere?.radius ?? 1;
            const r = (t.sx ?? 1) * geoR;
            const dx = px - t.x;
            const dy = py - t.y;
            const dz = pz - t.z;
            const rr = r + shipR;
            if (dx * dx + dy * dy + dz * dz > rr * rr) continue;

            const kind = meta?.kind ?? meta?.type ?? 'asteroid_small';
            const dps = V1.collisionDamage.dpsByKind?.[kind] ?? 0;
            dmg += dps * dtSec;
        }
        if (dmg > 0) this.applyShipDamage(dmg);
    }

    applyShipDamage(amount) {
        let a = Math.max(0, amount ?? 0);
        if (a <= 0) return;

        const s = this.stats.shield ?? 0;
        if (s > 0) {
            const use = Math.min(s, a);
            this.stats.shield = s - use;
            a -= use;
        }
        if (a > 0) {
            this.stats.hull = Math.max(0, (this.stats.hull ?? 0) - a);
        }
    }

    tryWarpToBase() {
        if (this.isPaused) return;
        if (!this.playerEntityId || !this.baseStation) return;
        const now = this._nowSec();
        const left = Math.max(0, (this.warpReadyAtSec ?? 0) - now);
        if (left > 0.01 && !this.isPowerupActive(V1.powerups.freeWarp.id)) {
            this.showMessage(`Warp cooling down (${left.toFixed(1)}s)`);
            return;
        }

        const t = this.world.transform.get(this.playerEntityId);
        const v = this.world.velocity.get(this.playerEntityId);
        if (!t || !v) return;

        const ws = this.worldScale ?? 1;
        const bx = this.baseStation.position.x;
        const by = this.baseStation.position.y;
        const bz = this.baseStation.position.z;

        // Teleport a bit in front of the base station.
        t.x = bx;
        t.y = by;
        t.z = bz + 75 * ws;
        v.x = 0; v.y = 0; v.z = 0;

        // Reset cargo and refill.
        this.stats.cargoUsed = 0;
        this.stats.hull = this.shipDerived.maxHull;
        this.stats.shield = this.shieldDerived.max;

        this.warpLastAtSec = now;
        this.warpReadyAtSec = now + (this.shipDerived.warpCooldownSec ?? 10);

        // Sync render mesh immediately.
        if (this.player) {
            this.player.position.set(t.x, t.y, t.z);
        }

        this.showMessage('Warped to Base.');
        this.openBaseMenu();
        this.updateHudStats();
    }

    openBaseMenu() {
        this.isPaused = true;
        if (this.hud) this.hud.setBaseMenuVisible(true);
        this.refreshBaseMenu();
    }

    refreshBaseMenu() {
        if (!this.hud) return;
        const maxTierShip = V1.shipUpgrades.maxTier ?? 3;
        const maxTierWeapon = V1.weaponUpgrades.maxTier ?? 3;

        const shipCosts = {};
        const shipDisabled = {};
        for (const k of ['speed', 'hull', 'cargo', 'warp']) {
            const tier = this.shipUpgrades?.[k] ?? 0;
            if (tier >= maxTierShip) {
                shipCosts[k] = null;
                shipDisabled[k] = true;
            } else {
                const cost = V1.shipUpgrades[k]?.costs?.[tier] ?? 0;
                shipCosts[k] = cost;
                shipDisabled[k] = this.stats.coin < cost;
            }
        }

        const weaponCosts = {};
        const weaponDisabled = {};
        for (const k of ['damage', 'fireRate']) {
            const tier = this.weaponUpgrades?.[k] ?? 0;
            if (tier >= maxTierWeapon) {
                weaponCosts[k] = null;
                weaponDisabled[k] = true;
            } else {
                const cost = V1.weaponUpgrades[k]?.costs?.[tier] ?? 0;
                weaponCosts[k] = cost;
                weaponDisabled[k] = this.stats.coin < cost;
            }
        }

        const lvl = Math.max(1, Math.min(3, this.weaponLevelTier ?? 1));
        const canCraft = lvl < 3;
        const nextLvl = Math.min(3, lvl + 1);
        const craftCost = canCraft ? (V1.weaponLevels.tiers?.[nextLvl]?.gemCost ?? 0) : null;
        const craftDisabled = !canCraft || this.stats.gem < (craftCost ?? 0);

        const emptySlots = (this.addonSlots ?? []).filter((x) => !x).length;
        const addonDisabled = {
            magnet: emptySlots <= 0 || this.stats.gem < (V1.addons.magnet.gemCost ?? 0),
            shield: emptySlots <= 0 || this.stats.gem < (V1.addons.shield.gemCost ?? 0)
        };

        const slotObjs = (this.addonSlots ?? []).map((id) => {
            if (!id) return null;
            if (id === 'magnet') return { id, name: V1.addons.magnet.name };
            if (id === 'shield') return { id, name: V1.addons.shield.name };
            return { id, name: id };
        });

        this.hud.setBaseMenuState({
            coin: this.stats.coin,
            gem: this.stats.gem,
            weaponLevelTier: this.weaponLevelTier,
            costs: {
                ship: shipCosts,
                weapon: weaponCosts,
                weaponLevelGem: craftCost,
                addon: { magnet: V1.addons.magnet.gemCost, shield: V1.addons.shield.gemCost }
            },
            disabled: {
                ship: shipDisabled,
                weapon: weaponDisabled,
                craftWeaponLevel: craftDisabled,
                addon: addonDisabled
            },
            addonSlots: slotObjs
        });
    }

    upgradeShipStat(statId) {
        const id = String(statId || '');
        if (!['speed', 'hull', 'cargo', 'warp'].includes(id)) return;
        const tier = this.shipUpgrades[id] ?? 0;
        const maxTier = V1.shipUpgrades.maxTier ?? 3;
        if (tier >= maxTier) return void this.showMessage('MAX tier.');
        const cost = V1.shipUpgrades[id]?.costs?.[tier] ?? 0;
        if (this.stats.coin < cost) return void this.showMessage('Not enough Coin.');
        this.stats.coin -= cost;
        this.shipUpgrades[id] = tier + 1;
        this.recomputeDerivedStats();
        if (id === 'hull') this.stats.hull = this.shipDerived.maxHull; // refill on hull upgrade
        this.showMessage(`Upgraded ${id.toUpperCase()}.`);
        this.refreshBaseMenu();
        this.updateHudStats();
    }

    upgradeWeaponAttr(attrId) {
        const id = String(attrId || '');
        if (!['damage', 'fireRate'].includes(id)) return;
        const tier = this.weaponUpgrades[id] ?? 0;
        const maxTier = V1.weaponUpgrades.maxTier ?? 3;
        if (tier >= maxTier) return void this.showMessage('MAX tier.');
        const cost = V1.weaponUpgrades[id]?.costs?.[tier] ?? 0;
        if (this.stats.coin < cost) return void this.showMessage('Not enough Coin.');
        this.stats.coin -= cost;
        this.weaponUpgrades[id] = tier + 1;
        this.recomputeDerivedStats();
        this.showMessage(`Upgraded ${id.toUpperCase()}.`);
        this.refreshBaseMenu();
        this.updateHudStats();
    }

    craftWeaponLevel() {
        const lvl = Math.max(1, Math.min(3, this.weaponLevelTier ?? 1));
        if (lvl >= 3) return void this.showMessage('Weapon Level MAX.');
        const next = lvl + 1;
        const cost = V1.weaponLevels.tiers?.[next]?.gemCost ?? 0;
        if (this.stats.gem < cost) return void this.showMessage('Not enough Gem.');
        this.stats.gem -= cost;
        this.weaponLevelTier = next;
        this.recomputeDerivedStats();
        this.showMessage(`Weapon Level ${next}.`);
        this.refreshBaseMenu();
        this.updateHudStats();
    }

    buyAddon(addonId) {
        const id = String(addonId || '');
        if (!['magnet', 'shield'].includes(id)) return;
        const empty = (this.addonSlots ?? []).findIndex((x) => !x);
        if (empty < 0) return void this.showMessage('Addon slots full.');
        const cost = id === 'magnet' ? (V1.addons.magnet.gemCost ?? 0) : (V1.addons.shield.gemCost ?? 0);
        if (this.stats.gem < cost) return void this.showMessage('Not enough Gem.');
        this.stats.gem -= cost;
        this.addonSlots[empty] = id;
        this.recomputeDerivedStats();
        if (id === 'shield') this.stats.shield = this.shieldDerived.max; // fill on first install
        this.showMessage(`Bought ${id.toUpperCase()}.`);
        this.refreshBaseMenu();
        this.updateHudStats();
    }

    createSpaceDust() {
        const dustGeo = new THREE.BufferGeometry();
        const dustCount = 2000;
        const posArray = new Float32Array(dustCount * 3);
        
        for(let i = 0; i < dustCount * 3; i++) {
            posArray[i] = (Math.random() - 0.5) * 400 * this.worldScale; // scaled box
        }
        
        dustGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
        
        const dustMat = new THREE.PointsMaterial({
            color: 0xbfe6ff,
            size: 1.1,
            transparent: true,
            opacity: 0.65,
            sizeAttenuation: true
        });
        
        this.spaceDustPoints = new THREE.Points(dustGeo, dustMat);
        this.spaceDustPoints.userData = { range: 200 * this.worldScale };
        this.scene.add(this.spaceDustPoints);
    }

    createRetroBackdrop() {
        // Pixel-ish stars (parallax-ish via wrap drift in EnvironmentSystem)
        const mkLayer = ({ count, range, size, color, opacity, drift }) => {
            const geo = new THREE.BufferGeometry();
            const pos = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                const ix = i * 3;
                pos[ix] = (Math.random() - 0.5) * range * 2;
                pos[ix + 1] = (Math.random() - 0.5) * range * 2;
                pos[ix + 2] = (Math.random() - 0.5) * range * 2;
            }
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            const mat = new THREE.PointsMaterial({
                color,
                size,
                transparent: true,
                opacity,
                sizeAttenuation: true
            });
            const points = new THREE.Points(geo, mat);
            this.scene.add(points);
            return { points, range, drift };
        };

        const ws = this.worldScale;
        this.retroBackdropLayers = [
            mkLayer({ count: 850, range: 550 * ws, size: 3.2, color: 0xe7f1ff, opacity: 0.95, drift: 0.24 }),
            mkLayer({ count: 520, range: 850 * ws, size: 3.8, color: 0xbfe0ff, opacity: 0.85, drift: 0.16 }),
            mkLayer({ count: 260, range: 1200 * ws, size: 4.5, color: 0xffd7b2, opacity: 0.78, drift: 0.09 })
        ];

        // Big pixel nebula sprites (chunky and low-detail on purpose)
        const nebTex = this._createPixelNebulaTexture(128);
        const colors = [0x6c2bd9, 0x2b77ff, 0xff2b75, 0x2bffcc];
        this.retroNebulaSprites = [];
        for (let i = 0; i < 12; i++) {
            const c = colors[i % colors.length];
            const mat = new THREE.SpriteMaterial({
                map: nebTex,
                color: c,
                transparent: true,
                opacity: 0.22,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const s = new THREE.Sprite(mat);
            const scale = 900 + Math.random() * 1700;
            s.scale.set(scale, scale, 1);
            s.position.set(
                (Math.random() - 0.5) * 3500 * ws,
                (Math.random() - 0.5) * 3500 * ws,
                (Math.random() - 0.5) * 3500 * ws
            );
            s.material.rotation = Math.random() * Math.PI * 2;
            s.userData = { range: 2200 * ws };
            this.scene.add(s);
            this.retroNebulaSprites.push(s);
        }
    }

    _createPixelNebulaTexture(size) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);

        // Blocky noise blobs
        const cell = 4;
        for (let y = 0; y < size; y += cell) {
            for (let x = 0; x < size; x += cell) {
                const nx = (x / size) * 2 - 1;
                const ny = (y / size) * 2 - 1;
                const r = Math.sqrt(nx * nx + ny * ny);
                const edge = Math.max(0, 1 - r);
                const v = Math.random() * edge;
                if (v < 0.28) continue;
                const a = Math.min(1, (v - 0.28) * 0.9);
                ctx.fillStyle = `rgba(255,255,255,${a * 0.55})`;
                ctx.fillRect(x, y, cell, cell);
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    _createSpaceBackgroundTexture(size = 512) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Gradient base (slightly brighter center to give depth).
        const g = ctx.createRadialGradient(size * 0.52, size * 0.45, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
        g.addColorStop(0, '#243a7a');
        g.addColorStop(0.45, '#101a3a');
        g.addColorStop(1, '#050714');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);

        // Subtle color noise to avoid flatness.
        const img = ctx.getImageData(0, 0, size, size);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const n = (Math.random() - 0.5) * 14; // +-7
            d[i] = Math.max(0, Math.min(255, d[i] + n));
            d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
            d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
        }
        ctx.putImageData(img, 0, 0);

        // Few large faint stars (background only).
        ctx.fillStyle = 'rgba(230,245,255,0.10)';
        for (let i = 0; i < 140; i++) {
            const x = Math.random() * size;
            const y = Math.random() * size;
            const r = Math.random() < 0.1 ? 2 : 1;
            ctx.fillRect(x, y, r, r);
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    createBaseStation() {
        const group = new THREE.Group();

        const hull = new Set();
        const dark = new Set();
        const lights = new Set();

        // Chunky "voxel station" silhouette.
        addBox(hull, -5, -2, -5, 5, 2, 5);
        addBox(hull, -12, -1, -2, -6, 1, 2);
        addBox(hull, 6, -1, -2, 12, 1, 2);
        addBox(hull, -2, -1, -12, 2, 1, -6);
        addBox(hull, -2, -1, 6, 2, 1, 12);

        // Dark insets / docking bays.
        addBox(dark, -3, -1, 6, 3, 1, 9);
        addBox(dark, -3, -1, -9, 3, 1, -6);
        addBox(dark, -9, -1, -3, -6, 1, 3);
        addBox(dark, 6, -1, -3, 9, 1, 3);

        // Light strips.
        addBox(lights, -5, 3, -1, -1, 3, 1);
        addBox(lights, 1, 3, -1, 5, 3, 1);
        addBox(lights, -1, 0, 12, 1, 0, 14);

        const hullMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(hull, { voxelSize: this.voxel.size, faceShading: true }),
            this._voxLit({ color: this.theme.station.hull, map: this._voxelTextures.panels, emissive: 0x0b0c12, emissiveIntensity: 0.06 })
        );
        const darkMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(dark, { voxelSize: this.voxel.size, faceShading: true }),
            this._voxLit({ color: this.theme.station.dark, map: this._voxelTextures.panelsDark, emissive: 0x070814, emissiveIntensity: 0.12 })
        );
        const lightMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(lights, { voxelSize: this.voxel.size, faceShading: false }),
            this._voxLit({ color: this.theme.station.light, map: null, emissive: this.theme.station.light, emissiveIntensity: 1.35 })
        );

        group.add(hullMesh, darkMesh, lightMesh);

        this.baseStation = group;
        this.baseStation.position.set(0, 0, -120 * this.worldScale);
        this.scene.add(this.baseStation);

        this._registerDistanceLabel(this.baseStation, {
            kind: 'base',
            prefix: 'BASE',
            yOffset: 40 * this.worldScale
        });
        
        // Add a glow or some indicator
        const light = new THREE.PointLight(0x00ffff, 65, 90 * this.worldScale);
        light.position.copy(this.baseStation.position);
        this.scene.add(light);
    }

    _voxLit({
        color,
        map = null,
        emissive = 0x000000,
        emissiveIntensity = 0.0,
        metalness = 0.0,
        roughness = 1.0,
        flatShading = true
    } = {}) {
        const mat = new THREE.MeshStandardMaterial({
            color,
            map: map ?? null,
            emissive,
            emissiveIntensity,
            metalness,
            roughness,
            flatShading,
            vertexColors: true
        });
        return mat;
    }

    _initVoxelTextures() {
        this._voxelTextures = createVoxelTextures();
    }

    createPlayerShip() {
        const { group, engineOffsets, muzzleOffset } = createVoxelShipModel({
            shipData: this.shipData,
            voxelSize: this.voxel.size,
            textures: this._voxelTextures,
            theme: this.theme,
            voxLit: (opts) => this._voxLit(opts)
        });

        this.engineOffsets = engineOffsets;
        this.shipMuzzleOffset = muzzleOffset;
        this.player = group;
        this.scene.add(this.player);

        // Collision radius for minimal hull/shield damage (V1). Keep it stable and cheap.
        {
            const box = new THREE.Box3().setFromObject(this.player);
            const sphere = new THREE.Sphere();
            box.getBoundingSphere(sphere);
            this.shipCollisionRadiusWorld = Math.max(1, sphere.radius);
        }
        
        // Initial position
        this.player.position.set(0, 0, 0);

        // "Headlight" so nearby asteroids read. Slightly forward and above.
        const vox = this.voxel.size ?? 1;
        this.shipLight = new THREE.PointLight(0x88ccff, 1.6, 850 * this.worldScale, 2);
        this.shipLight.position.set(0, 2 * vox, 18 * vox);
        this.player.add(this.shipLight);

        // World-first: player simulation state
        this.playerEntityId = this.world.createEntity();
        this.renderRegistry.bind(this.playerEntityId, this.player);
        this.world.transform.set(this.playerEntityId, {
            x: this.player.position.x,
            y: this.player.position.y,
            z: this.player.position.z,
            rx: 0,
            ry: 0,
            rz: 0,
            sx: 1,
            sy: 1,
            sz: 1
        });
        this.world.velocity.set(this.playerEntityId, { x: 0, y: 0, z: 0 });
        this.world.rotationQuat.set(this.playerEntityId, {
            x: this.player.quaternion.x,
            y: this.player.quaternion.y,
            z: this.player.quaternion.z,
            w: this.player.quaternion.w
        });
        
        // Physics State
        this.currentSpeed = 0;
    }

    createEnvironment() {
        // Pre-bake a handful of voxel asteroid geometries; reuse them for spawns.
        if (!this._voxelAsteroidVariants) {
            this._voxelAsteroidVariants = [];
            for (let i = 0; i < 16; i++) {
                const rng = mulberry32(0xdecafbad + i * 1013);
                const filled = new Set();
                const r = 2 + Math.floor(rng() * 6); // 2..7 voxels
                addSphere(filled, r, { hollow: false, jitter: 1.25, rng });
                for (const k of Array.from(filled)) {
                    if (rng() < 0.10) filled.delete(k);
                }
                const geo = buildVoxelSurfaceGeometry(filled, {
                    voxelSize: this.voxel.size,
                    shadeTop: 1.0,
                    shadeSide: 0.92,
                    shadeBottom: 0.78
                });
                geo.computeBoundingSphere();
                const br = geo.boundingSphere?.radius ?? 1;
                const normScale = br > 0.00001 ? 1 / br : 1;
                if (normScale !== 1) geo.scale(normScale, normScale, normScale);
                geo.computeBoundingSphere();
                this._voxelAsteroidVariants.push({
                    geo,
                    filled,
                    voxelSizeOriginal: this.voxel.size,
                    normScale,
                    shadeTop: 1.0,
                    shadeSide: 0.92,
                    shadeBottom: 0.78
                });
            }
        }

        const ws = this.worldScale ?? 1;
        const asteroidRange = (V1.spawn.asteroidRange ?? 2200) * ws;
        const spawnAsteroid = (kind, i) => {
            const variant = this._voxelAsteroidVariants[Math.floor(Math.random() * this._voxelAsteroidVariants.length)];
            const baseColorHex = this.theme.asteroidPalette[Math.floor(Math.random() * this.theme.asteroidPalette.length)];
            const baseColor = new THREE.Color(baseColorHex);
            baseColor.offsetHSL((Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.18, (Math.random() - 0.5) * 0.14);
            baseColor.multiplyScalar(0.95 + Math.random() * 0.35);
            const material = this._voxLit({
                color: baseColor,
                map: this._voxelTextures.rock,
                emissive: baseColor.clone().multiplyScalar(0.10),
                emissiveIntensity: 0.12 + Math.random() * 0.16,
                roughness: 0.95,
                metalness: 0.02
            });

            const asteroid = new THREE.Mesh(variant.geo, material);
            const scale = kind === 'asteroid_big' ? 11.0 * ws : 4.2 * ws;
            asteroid.scale.set(scale, scale, scale);

            asteroid.position.set(
                (Math.random() - 0.5) * asteroidRange * 2,
                (Math.random() - 0.5) * asteroidRange * 2,
                (Math.random() - 0.5) * asteroidRange * 2
            );
            asteroid.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

            // Don't place near base.
            if (asteroid.position.distanceTo(this.baseStation.position) < 180 * ws) {
                asteroid.position.x += 360 * ws;
            }

            asteroid.userData = {
                type: 'asteroid',
                rotationSpeed: {
                    x: (Math.random() - 0.5) * 0.01,
                    y: (Math.random() - 0.5) * 0.01,
                    z: (Math.random() - 0.5) * 0.01
                },
                voxel: null
            };

            // Per-instance voxel state for destruction.
            {
                const filled = new Set(variant.filled);
                asteroid.userData.voxel = {
                    filled,
                    resource: new Set(),
                    resourceRate: 0,
                    initialCount: filled.size,
                    voxelSizeOriginal: variant.voxelSizeOriginal,
                    normScale: variant.normScale,
                    shadeTop: variant.shadeTop,
                    shadeSide: variant.shadeSide,
                    shadeBottom: variant.shadeBottom,
                    lastRebuildAtSec: -999
                };
            }

            const hp = V1.targets[kind]?.hp ?? 120;
            const entityId = this.world.createObject({ type: 'asteroid', kind, hp, maxHp: hp });
            this.renderRegistry.bind(entityId, asteroid);
            this.world.transform.set(entityId, {
                x: asteroid.position.x,
                y: asteroid.position.y,
                z: asteroid.position.z,
                rx: asteroid.rotation.x,
                ry: asteroid.rotation.y,
                rz: asteroid.rotation.z,
                sx: asteroid.scale.x,
                sy: asteroid.scale.y,
                sz: asteroid.scale.z
            });
            this.world.spin.set(entityId, {
                x: asteroid.userData.rotationSpeed.x,
                y: asteroid.userData.rotationSpeed.y,
                z: asteroid.userData.rotationSpeed.z
            });

            this.createHealthBar(asteroid);
            this.scene.add(asteroid);
            this.objects.push(asteroid);

            void i;
        };

        const nSmall = V1.spawn.smallAsteroids ?? 260;
        const nBig = V1.spawn.bigAsteroids ?? 70;
        for (let i = 0; i < nSmall; i++) spawnAsteroid('asteroid_small', i);
        for (let i = 0; i < nBig; i++) spawnAsteroid('asteroid_big', i);

        // Planets: voxel shells (chunky).
        const wantPlanetUvMode = 'world';
        const wantPlanetUvScale = 0.09;
        if (!this._voxelPlanetVariants || this._voxelPlanetVariantsUvMode !== wantPlanetUvMode || this._voxelPlanetVariantsUvScale !== wantPlanetUvScale) {
            this._voxelPlanetVariants = [];
            for (let i = 0; i < 4; i++) {
                const rng = mulberry32(0x12345678 + i * 99991);
                const filled = new Set();
                const r = 11 + Math.floor(rng() * 3); // 11..13 voxels
                addSphere(filled, r, { hollow: true, thickness: 2, jitter: 0.75, rng });
                // Planets: use world UVs so texture spans across voxels (avoids noisy per-voxel tiling).
                const geo = buildVoxelSurfaceGeometry(filled, { voxelSize: 1.0, uvMode: wantPlanetUvMode, uvScale: wantPlanetUvScale });
                geo.computeBoundingSphere();
                const br = geo.boundingSphere?.radius ?? 1;
                const normScale = br > 0.00001 ? 1 / br : 1;
                if (normScale !== 1) geo.scale(normScale, normScale, normScale);
                geo.computeBoundingSphere();
                this._voxelPlanetVariants.push({ geo, filled, voxelSizeOriginal: 1.0, normScale });
            }
            this._voxelPlanetVariantsUvMode = wantPlanetUvMode;
            this._voxelPlanetVariantsUvScale = wantPlanetUvScale;
        }

        const planetColors = [0xff7733, 0x3366ff, 0x44aa44, 0xaa44ff];
        const nPlanets = V1.spawn.miniPlanets ?? 6;
        for (let i = 0; i < nPlanets; i++) {
            const color = planetColors[i % planetColors.length];
            const variant = this._voxelPlanetVariants[i % this._voxelPlanetVariants.length];
            const mat = this._voxLit({
                color,
                map: this._voxelTextures.rockBlob ?? this._voxelTextures.rockSoft ?? this._voxelTextures.rock,
                emissive: 0x000000,
                emissiveIntensity: 0.0
            });
            // Planets: prioritize voxel silhouette/readability over surface noise.
            mat.roughness = 0.98;
            mat.metalness = 0.0;
            const planet = new THREE.Mesh(variant.geo, mat);
            const scale = 120 * ws;
            planet.scale.set(scale, scale, scale);

            planet.position.set(
                (Math.random() - 0.5) * 6000 * ws,
                (Math.random() - 0.5) * 6000 * ws,
                (Math.random() - 0.5) * 6000 * ws
            );

            planet.userData = {
                type: 'planet',
                voxel: null
            };

            {
                const filled = new Set(variant.filled);
                planet.userData.voxel = {
                    filled,
                    resource: new Set(),
                    resourceRate: 0,
                    initialCount: filled.size,
                    voxelSizeOriginal: variant.voxelSizeOriginal,
                    normScale: variant.normScale,
                    shadeTop: 1.0,
                    shadeSide: 0.88,
                    shadeBottom: 0.72,
                    uvMode: 'world',
                    uvScale: 0.09,
                    lastRebuildAtSec: -999
                };
            }

            const hp = V1.targets.planet_mini.hp ?? 500;
            const planetEntityId = this.world.createObject({ type: 'planet', kind: 'planet_mini', hp, maxHp: hp });
            this.renderRegistry.bind(planetEntityId, planet);
            this.world.transform.set(planetEntityId, {
                x: planet.position.x,
                y: planet.position.y,
                z: planet.position.z,
                rx: planet.rotation.x,
                ry: planet.rotation.y,
                rz: planet.rotation.z,
                sx: planet.scale.x,
                sy: planet.scale.y,
                sz: planet.scale.z
            });
            this.world.spin.set(planetEntityId, { x: 0, y: 0.001, z: 0 });

            this.createHealthBar(planet);
            this.scene.add(planet);
            this.objects.push(planet);

            this._registerDistanceLabel(planet, {
                kind: 'planet',
                prefix: `P${i + 1}`,
                yOffset: planet.scale.x * 1.05 + 30 * ws
            });

            const glow = new THREE.Sprite(
                new THREE.SpriteMaterial({
                    map: this.vfx.createGlowTexture('#ffffff'),
                    color,
                    transparent: true,
                    opacity: 0.18,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                })
            );
            glow.scale.set(3.6, 3.6, 1);
            planet.add(glow);
        }
    }

    _registerDistanceLabel(target, { kind, prefix, yOffset }) {
        if (!this.scene || !target) return;
        const ws = this.worldScale ?? 1;
        const sprite = this._createDistanceLabelSprite();
        sprite.position.copy(target.position);
        sprite.position.y += yOffset;
        this.scene.add(sprite);
        this.distanceLabelTargets.push({ kind, target, sprite, yOffset, prefix, lastText: '', baseScale: sprite.scale.clone() });
    }

    _createDistanceLabelSprite() {
        const ws = this.worldScale ?? 1;
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        const mat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(mat);
        // World-size for readability at current worldScale.
        sprite.scale.set(70 * ws, 18 * ws, 1);

        sprite.userData._label = { canvas, ctx, tex };
        // Initialize with placeholder to avoid blank sprite flash.
        this._setDistanceLabelText(sprite, '...');
        return sprite;
    }

    _formatDistanceForLabel(distWorld) {
        const ws = this.worldScale ?? 1;
        const d = distWorld / ws; // keep numbers stable when voxel/world scale changes
        if (d >= 1000) return `${(d / 1000).toFixed(1)}km`;
        return `${Math.round(d)}m`;
    }

    _setDistanceLabelText(sprite, text) {
        const info = sprite?.userData?._label;
        if (!info) return;
        const { ctx, canvas, tex } = info;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Backplate
        ctx.fillStyle = 'rgba(7, 10, 18, 0.70)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Border
        ctx.strokeStyle = 'rgba(180, 220, 255, 0.55)';
        ctx.lineWidth = 3;
        ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);

        // Text
        ctx.font = 'bold 30px monospace';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(230, 245, 255, 0.98)';
        ctx.fillText(text, 14, canvas.height / 2 + 1);

        tex.needsUpdate = true;
    }

    updateBaseMarker(dtSec, nowSec) {
        // Kept as a wrapper for now (older callsites); system owns implementation.
        this.navigation.update(dtSec, nowSec);
    }

    shoot() {
        this.combat.shoot();
    }

    update(dtSec = 1 / 60) {
        if (this.isPaused) return;
        this._simTimeSec += dtSec;
        const now = this._simTimeSec;

        // Order matters:
        // 1) movement updates player transform
        // 2) environment updates + syncs world objects (so combat reads fresh world transforms)
        // 3) camera follows player
        // 4) combat uses player+world transforms
        // 5) navigation uses camera
        this.movement.update(dtSec, now);
        this.environment.update(dtSec, now);
        this._tickShipSystems(dtSec, now);
        this.cameraSystem.update(dtSec, now);
        this.combat.update(dtSec, now);
        this.voxelDestruction.update(dtSec, now);
        this.updateBaseMarker(dtSec, now);

        this.vfx.update(dtSec, now);

        this.loot.update(dtSec, now);
        this.updateHudStats();
    }

    destroyObject(obj, index) {
        // High impact camera shake on destruction
        this.cameraShake = obj.userData.type === 'planet' ? 2.5 : 1.2;
        
        this.soundManager.playExplosion(obj.scale.x);

        // Enhanced explosion visuals
        this.vfx.createExplosion(obj.position, obj.scale.x, obj.userData.type);
        this.spawner.spawnOnDestroyed(obj);

        if (obj.userData.entityId) {
            if (this.currentTargetEntityId === obj.userData.entityId) {
                this.currentTargetEntityId = null;
                if (this.hud) {
                    if (this.hud.crosshairUnlockAndSnapToCenter) this.hud.crosshairUnlockAndSnapToCenter();
                    else {
                        this.hud.crosshairSetLocked(false);
                        this.hud.crosshairResetToCenter();
                    }
                }
                this._lockSuppressUntilSec = (this._simTimeSec ?? 0) + 0.25;
            }
            this.renderRegistry.unbind(obj.userData.entityId);
            this.world.removeEntity(obj.userData.entityId);
        }
        this.scene.remove(obj);
        this.objects.splice(index, 1);
        this.showMessage(`Exploded ${obj.userData.type.toUpperCase()}!`);
    }

    /**
     * World-first destroy entrypoint. Prefer this over passing array indices around.
     * @param {number} entityId
     */
    destroyObjectEntity(entityId) {
        // Test area: respawn the single targets so the scene stays useful for iteration.
        const testMeta = this.mode === 'testArea' ? (this.world.objectMeta.get(entityId) ?? null) : null;
        if (this.currentTargetEntityId === entityId) {
            this.currentTargetEntityId = null;
            if (this.hud) {
                if (this.hud.crosshairUnlockAndSnapToCenter) this.hud.crosshairUnlockAndSnapToCenter();
                else {
                    this.hud.crosshairSetLocked(false);
                    this.hud.crosshairResetToCenter();
                }
            }
            this._lockSuppressUntilSec = (this._simTimeSec ?? 0) + 0.25;
        }

        const obj = this.renderRegistry.get(entityId);
        if (!obj) {
            // Fallback: ensure sim state is cleared.
            this.renderRegistry.unbind(entityId);
            this.world.removeEntity(entityId);
            if (testMeta) this._scheduleTestAreaRespawn(testMeta);
            return;
        }

        const idx = this.objects.indexOf(obj);
        if (idx >= 0) {
            this.destroyObject(obj, idx);
            if (testMeta) this._scheduleTestAreaRespawn(testMeta);
            return;
        }

        // Not found in list; still clean up safely.
        this.vfx.createExplosion(obj.position, obj.scale.x, obj.userData.type);
        this.spawner.spawnOnDestroyed(obj);
        this.renderRegistry.unbind(entityId);
        this.world.removeEntity(entityId);
        this.scene.remove(obj);

        if (testMeta) this._scheduleTestAreaRespawn(testMeta);
    }

    createHealthBar(object) {
        const ws = this.worldScale ?? 1;
        const canvas = document.createElement('canvas');
        // Keep it intentionally simple and small on screen.
        canvas.width = 96;
        canvas.height = 12;
        const context = canvas.getContext('2d');
        
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        const material = new THREE.SpriteMaterial({ 
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        
        const sprite = new THREE.Sprite(material);
        // IMPORTANT: sprite is parented under objects that are scaled up/down.
        // Keep the bar a constant SCREEN size by scaling with camera distance.
        sprite.visible = false;
        
        object.add(sprite);
        object.userData.healthBar = {
            sprite: sprite,
            canvas: canvas,
            context: context,
            texture: texture,
            // Desired on-screen size. This keeps asteroids and planets consistent.
            pixelSize: { w: 90, h: 6 },
            padWorld: 12 * ws
        };
        
        this.updateHealthBar(object);
    }

    layoutHealthBar(object) {
        const hb = object?.userData?.healthBar;
        if (!hb || !hb.sprite) return;
        if (!this.camera) return;

        // Because the sprite is parented under a (typically uniformly) scaled object, we scale it inversely
        // so its WORLD size matches our computed "keep X pixels on screen" goal.
        if (!this._hbTmpObjWorld) this._hbTmpObjWorld = new THREE.Vector3();
        if (!this._hbTmpCamSpace) this._hbTmpCamSpace = new THREE.Vector3();
        if (!this._hbTmpWorldScale) this._hbTmpWorldScale = new THREE.Vector3();
        const objWorldScaleV = object.getWorldScale(this._hbTmpWorldScale);
        const objWorldScale = Math.max(0.0001, objWorldScaleV.x);

        // Use camera-space depth rather than Euclidean distance so off-center targets keep consistent UI size.
        object.getWorldPosition(this._hbTmpObjWorld);
        this._hbTmpCamSpace.copy(this._hbTmpObjWorld).applyMatrix4(this.camera.matrixWorldInverse);
        const depth = Math.max(0.001, -this._hbTmpCamSpace.z);

        const vh = this.renderer?.domElement?.clientHeight || window.innerHeight || 720;
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const worldHeight = 2 * depth * Math.tan(fovRad * 0.5);
        const unitsPerPx = worldHeight / vh;

        const desiredWorldW = hb.pixelSize.w * unitsPerPx;
        const desiredWorldH = hb.pixelSize.h * unitsPerPx;
        hb.sprite.scale.set(desiredWorldW / objWorldScale, desiredWorldH / objWorldScale, 1);

        // Our voxel objects are unit-radius geometry scaled uniformly, so radius ~= scale.x.
        const desiredYWorld = objWorldScale + hb.padWorld;
        hb.sprite.position.set(0, desiredYWorld / objWorldScale, 0);
    }

    updateHealthBar(object) {
        const hb = object.userData.healthBar;
        if (!hb) return;
        
        const { context, canvas, texture } = hb;
        this.layoutHealthBar(object);

        const entityId = object.userData.entityId;
        const h = entityId ? this.world.getHealth(entityId) : null;
        if (!h) return;
        const hpPercent = h.hp / h.maxHp;
        
        context.clearRect(0, 0, canvas.width, canvas.height);
        
        // Ultra-simple bar: faint background track + single-color fill.
        context.fillStyle = 'rgba(0, 0, 0, 0.28)';
        context.fillRect(0, 0, canvas.width, canvas.height);

        const inset = 1;
        const w = canvas.width - inset * 2;
        const hpx = canvas.height - inset * 2;

        context.fillStyle = 'rgba(120, 255, 180, 0.95)';
        context.fillRect(inset, inset, Math.max(0, w * hpPercent), hpx);
        
        texture.needsUpdate = true;
    }
    showMessage(text) {
        const isError =
            text.includes('Full') ||
            text.includes('Not enough') ||
            text.includes('cooling down') ||
            text.includes('Destroyed');
        if (isError) this.soundManager.playError();
        if (this.hud) this.hud.showMessage(text, { isError });
    }

    updateHudStats() {
        if (!this.hud) return;
        this.hud.setStats(this._getHudStats());
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        if (this.composer) {
            this.composer.setSize(window.innerWidth, window.innerHeight);
        }
    }

    animate(nowMs) {
        requestAnimationFrame((t) => this.animate(t));
        this._loop.advance(nowMs, (dtSec) => this.update(dtSec));
        if (this.composer) {
            this.composer.render();
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    dispose() {
        this._disposed = true;
        try {
            this.input.detach(window);
        } catch (_) {
            // ignore
        }
        if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._onMouseDown) window.removeEventListener('mousedown', this._onMouseDown);

        if (this.composer && this.composer.dispose) this.composer.dispose();
        if (this.renderer) this.renderer.dispose();
    }
}
