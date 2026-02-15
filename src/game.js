import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SoundManager } from './soundManager.js';
import { FixedTimestepLoop } from './core/fixedTimestepLoop.js';
import { KeyboardInput } from './input/keyboard.js';
import { MobileTouchControls } from './input/mobileTouchControls.js';
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

        // Planet "light beam" (visual only). Stored separately so we can animate without coupling to gameplay.
        this.planetBeams = [];
        this._planetBeamTexture = null;

        // Single spotlight used to brighten the currently locked planet.
        // This keeps the "planet is lit" look without adding dozens of dynamic lights.
        this.lockSpot = null;
        this.lockSpotTarget = null;
        
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
        /** @type {Record<string, boolean>} */
        this.virtualKeys = {};
        this.objects = [];
        this.bullets = [];
        this.particles = [];
        this.cameraShake = 0;
        this.isPaused = false;
        this.lastShotTime = 0;
        this._fireHeldMouse = false;
        this._fireHeldTouch = false;
        this._precisionHeldMouse = false;
        this._precisionHeldTouch = false;
        this.mobileControls = null;
        this.mobileControlsEnabled = false;

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

        // Single lock spotlight: only lights the current target, so it reads well without tanking FPS.
        this.lockSpotTarget = new THREE.Object3D();
        this.scene.add(this.lockSpotTarget);
        this.lockSpot = new THREE.SpotLight(0xffffff, 0.0, 6000 * this.worldScale, Math.PI * 0.60, 0.75, 1.1);
        this.lockSpot.position.set(0, 0, 0);
        this.lockSpot.target = this.lockSpotTarget;
        this.scene.add(this.lockSpot);

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
                this.hud.setControlsHint('WASD: Drive | 2x UP/DOWN: Speed | Z: Boost | CLICK/SPACE/X: Fire | SHIFT/RMB: Precision');
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

        // Fire can be held (mouse/touch). This also avoids "can't shoot while moving" on some keyboards
        // due to rollover/ghosting (W + Space not registering together).
        const isMobileUiTarget = (target) => {
            if (!target || typeof target.closest !== 'function') return false;
            return !!target.closest('#mobile-controls');
        };
        this._onPointerDown = (e) => {
            if (!e) return;
            if (isMobileUiTarget(e.target)) return;
            // RMB: precision aim (no fire)
            if (typeof e.button === 'number' && e.button === 2) {
                this._precisionHeldMouse = true;
                return;
            }
            // LMB: hold-to-fire
            if (typeof e.button === 'number' && e.button !== 0) return;
            this._fireHeldMouse = true;
            this.shoot();
        };
        this._onPointerUp = (e) => {
            if (e && typeof e.button === 'number' && e.button === 2) this._precisionHeldMouse = false;
            if (e && typeof e.button === 'number' && e.button === 0) this._fireHeldMouse = false;
            // Some browsers report -1; be safe.
            if (!e || e.button == null) {
                this._fireHeldMouse = false;
                this._precisionHeldMouse = false;
            }
        };
        this._onContextMenu = (e) => {
            // Prevent the browser menu while using RMB for precision aim.
            e.preventDefault();
        };
        window.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointerup', this._onPointerUp);
        window.addEventListener('pointercancel', this._onPointerUp);
        window.addEventListener('blur', this._onPointerUp);
        window.addEventListener('contextmenu', this._onContextMenu);

        this.mobileControls = new MobileTouchControls({ game: this, doc: document });
        this.mobileControlsEnabled = this.mobileControls.attach();
        if (this.mobileControlsEnabled && this.hud?.setControlsHint) {
            this.hud.setControlsHint('Swipe Pad: Steer | Fire: Tap/Hold | Boost: Hold | +/-: Speed | Warp: Button');
        }

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

        // A small, controlled scene: 1 planet, placed for quick interaction.
        // Planet: mid distance, large enough to read voxel carving.
        const planetKind = 'planet_medium';
        const planetScale = (planetKind === 'planet_large' ? 1500 : planetKind === 'planet_small' ? 85 : 450) * ws;
        // Keep it comfortably in front of the camera given the test-area far plane and huge planet scales.
        const planetPos = new THREE.Vector3(0, 0, planetScale * 3.2 + 600 * ws);
        this._testAreaCfg = { planetPos, planetKind };

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

        this._spawnTestAreaPlanet(planetKind);
    }

    _spawnTestAreaPlanet(kind = 'planet_medium') {
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
        const scale = kind === 'planet_large' ? 1500 * ws : kind === 'planet_small' ? 85 * ws : 450 * ws;
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

        const hp = V1.targets?.[kind]?.hp ?? V1.targets.planet_medium.hp;
        const entityId = this.world.createObject({ type: 'planet', kind, hp, maxHp: hp });
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

        // Stylized beam to improve depth and readability (matches the look we tested earlier).
        this._addPlanetBeam(planet, color);

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
        if (kind !== 'planet_small' && kind !== 'planet_medium' && kind !== 'planet_large') return;

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
            this._spawnTestAreaPlanet(kind);
        }, 1200);
    }

    _getPlanetBeamTexture() {
        if (this._planetBeamTexture) return this._planetBeamTexture;

        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Vertical falloff (brighter near the top, soft fade near bottom).
        const vg = ctx.createLinearGradient(0, 0, 0, canvas.height);
        vg.addColorStop(0.00, 'rgba(255,255,255,0.00)');
        vg.addColorStop(0.10, 'rgba(255,255,255,0.70)');
        vg.addColorStop(0.55, 'rgba(255,255,255,0.22)');
        vg.addColorStop(1.00, 'rgba(255,255,255,0.00)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Soft side edges so the cone reads like volumetric light.
        ctx.globalCompositeOperation = 'destination-in';
        const rg = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.width * 0.05, canvas.width / 2, canvas.height / 2, canvas.width * 0.55);
        rg.addColorStop(0.0, 'rgba(255,255,255,1.0)');
        rg.addColorStop(0.65, 'rgba(255,255,255,0.55)');
        rg.addColorStop(1.0, 'rgba(255,255,255,0.00)');
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1, 1.35);
        this._planetBeamTexture = tex;
        return tex;
    }

    /**
     * Visual only: adds a stylized light beam (spot + additive cone) around a planet to improve readability.
     * @param {THREE.Object3D} planet
     * @param {number} colorHex
     */
    _addPlanetBeam(planet, colorHex = 0xffffff) {
        if (!this.scene || !planet) return;

        // Avoid duplicates (respawns).
        if (planet.userData?._hasBeam) return;
        planet.userData._hasBeam = true;

        const ws = this.worldScale ?? 1;
        const geoR = planet.geometry?.boundingSphere?.radius ?? 1;
        const r = Math.max(1, (planet.scale?.x ?? 1) * geoR);

        const height = Math.max(140 * ws, r * 2.9);
        const radiusTop = Math.max(50 * ws, r * 1.12);
        const radiusBottom = Math.max(22 * ws, r * 0.50);

        const group = new THREE.Group();
        group.position.copy(planet.position);

        // Important for performance: beams are visual-only (additive cone). Actual "full planet lighting"
        // is handled by a single lock spotlight (see init()).
        void colorHex;

        // Volumetric cone (fake) with scrolling texture.
        const tex = this._getPlanetBeamTexture();
        const coneGeo = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 18, 1, true);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            map: tex,
            transparent: true,
            opacity: 0.20,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        const cone = new THREE.Mesh(coneGeo, mat);
        cone.position.set(0, height * 0.04, 0);
        group.add(cone);

        // Warm-ish rim to make the beam feel like it wraps the surface.
        const rimGeo = new THREE.RingGeometry(radiusBottom * 0.75, radiusTop * 0.92, 40, 1);
        const rimMat = new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 0.10,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        const rim = new THREE.Mesh(rimGeo, rimMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(0, 0.01, 0);
        group.add(rim);

        // Not parented to the planet so it doesn't spin with the mesh.
        this.scene.add(group);

        // Static orientation: slight random yaw so beams across planets don't look copy-pasted,
        // but no continuous animation (user preference: "atmosphere beam", not moving).
        group.rotation.y = (Math.random() - 0.5) * 0.5;
        group.rotation.x = (Math.random() - 0.5) * 0.12;

        const baseOpacity = 0.20;
        mat.opacity = baseOpacity;
        if (tex) tex.offset.set(0, 0);
        this.planetBeams.push({ target: planet, group, cone, mat, tex, baseOpacity });
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

    isControlActive(code) {
        return !!this.keys?.[code] || !!this.virtualKeys?.[code];
    }

    setVirtualKey(code, active) {
        if (!code) return;
        if (active) this.virtualKeys[code] = true;
        else delete this.virtualKeys[code];
    }

    setTouchFireHeld(active) {
        this._fireHeldTouch = !!active;
    }

    setTouchPrecisionHeld(active) {
        this._precisionHeldTouch = !!active;
    }

    isPrecisionAimActive() {
        return this.isControlActive('ShiftLeft') || this.isControlActive('ShiftRight') || !!this._precisionHeldMouse || !!this._precisionHeldTouch;
    }

    adjustThrottle(delta) {
        if (!this.throttle) return;
        const d = Math.sign(Number(delta) || 0);
        if (!d) return;
        const step = Math.max(1, this.throttle.step ?? 1);
        const next = THREE.MathUtils.clamp(this.throttle.level + d * step, this.throttle.min, this.throttle.max);
        if (next === this.throttle.level) return;
        this.throttle.level = next;
        this.showMessage(`Speed ${this.throttle.level}/${this.throttle.max}`);
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

            const kind = meta?.kind ?? meta?.type ?? 'planet_small';
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
        // Keep dust subtle: it's for speed/depth cues, not a visible particle field.
        const ws = this.worldScale ?? 1;
        const dustGeo = new THREE.BufferGeometry();
        const dustCount = 1200;
        const posArray = new Float32Array(dustCount * 3);

        const range = 320 * ws;
        for (let i = 0; i < dustCount; i++) {
            const ix = i * 3;
            posArray[ix] = (Math.random() - 0.5) * range * 2;
            posArray[ix + 1] = (Math.random() - 0.5) * range * 2;
            posArray[ix + 2] = (Math.random() - 0.5) * range * 2;
        }

        dustGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

        const dustMat = new THREE.PointsMaterial({
            color: 0xbfe6ff,
            size: 0.85 * ws,
            transparent: true,
            opacity: 0.28,
            sizeAttenuation: true,
            depthWrite: false
        });

        this.spaceDustPoints = new THREE.Points(dustGeo, dustMat);
        this.spaceDustPoints.userData = { range };
        this.scene.add(this.spaceDustPoints);

        // Clear any older multi-layer state.
        this.spaceDustLayers = null;
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
        // Keep it clean: 3 layers is enough for parallax without turning into "snow".
        this.retroBackdropLayers = [
            mkLayer({ count: 520, range: 620 * ws, size: 2.2 * ws, color: 0xeaf5ff, opacity: 0.75, drift: 0.20 }),
            mkLayer({ count: 320, range: 1100 * ws, size: 1.6 * ws, color: 0xbfe0ff, opacity: 0.55, drift: 0.12 }),
            mkLayer({ count: 180, range: 1800 * ws, size: 1.2 * ws, color: 0xffe6cf, opacity: 0.40, drift: 0.07 })
        ];

        // Big pixel nebula sprites (chunky and low-detail on purpose)
        const nebTex = this._createPixelNebulaTexture(128);
        const colors = [0x6c2bd9, 0x2b77ff, 0xff2b75, 0x2bffcc];
        this.retroNebulaSprites = [];
        for (let i = 0; i < 10; i++) {
            const c = colors[i % colors.length];
            const mat = new THREE.SpriteMaterial({
                map: nebTex,
                color: c,
                transparent: true,
                opacity: 0.16,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const s = new THREE.Sprite(mat);
            const scale = (1200 + Math.random() * 2200) * ws;
            s.scale.set(scale, scale, 1);
            s.position.set(
                (Math.random() - 0.5) * 5200 * ws,
                (Math.random() - 0.5) * 5200 * ws,
                (Math.random() - 0.5) * 5200 * ws
            );
            s.material.rotation = Math.random() * Math.PI * 2;
            // Static nebulas: drift read as "noise" more than depth in this art style.
            s.userData = { range: 3800 * ws };
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

        // IMPORTANT: Avoid a centered radial highlight.
        // A bright center reads like a fixed "headlight/fog oval" when combined with bloom.
        // Use a very subtle diagonal gradient + a few off-center dark clouds instead.
        const base = ctx.createLinearGradient(0, 0, size, size);
        base.addColorStop(0, '#101a3a');
        base.addColorStop(1, '#050714');
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, size, size);

        // Off-center very soft "nebula haze" blobs (kept dark so they don't bloom).
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 3; i++) {
            const cx = (0.15 + Math.random() * 0.70) * size;
            const cy = (0.15 + Math.random() * 0.70) * size;
            const rad = (0.30 + Math.random() * 0.35) * size;
            const rg = ctx.createRadialGradient(cx, cy, rad * 0.05, cx, cy, rad);
            rg.addColorStop(0.0, 'rgba(36,58,122,0.08)');
            rg.addColorStop(0.55, 'rgba(12,18,40,0.04)');
            rg.addColorStop(1.0, 'rgba(0,0,0,0.0)');
            ctx.fillStyle = rg;
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

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
        // Keep alpha low so bloom doesn't catch it.
        ctx.fillStyle = 'rgba(230,245,255,0.08)';
        for (let i = 0; i < 180; i++) {
            const x = Math.random() * size;
            const y = Math.random() * size;
            const r = Math.random() < 0.08 ? 2 : 1;
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
        // Planets-only world (asteroids disabled for now).
        const ws = this.worldScale ?? 1;

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

        // 2. Asteroids: solid voxel clumps (noise-filled).
        // Matches entryScene.js aesthetic: "voxel ball with noise".
        if (!this._voxelAsteroidVariants) {
            this._voxelAsteroidVariants = [];
            for (let i = 0; i < 6; i++) {
                const rng = mulberry32(0x99887766 + i * 54321);
                const filled = new Set();
                const r = 4 + Math.floor(rng() * 3); // 4..6 voxels radius
                
                // Create noisy ball
                for(let x=-r; x<=r; x++) {
                    for(let y=-r; y<=r; y++) {
                        for(let z=-r; z<=r; z++) {
                            if (x*x + y*y + z*z <= r*r) {
                                if (rng() > 0.65) continue; // 35% empty noise
                                filled.add(`${x},${y},${z}`);
                            }
                        }
                    }
                }

                // Surface-only geometry is fine for rendering, but for destruction we might want
                // to know it was "solid". For now, surface geometry is standard.
                const geo = buildVoxelSurfaceGeometry(filled, { 
                    voxelSize: 1.0, 
                    uvMode: 'perFace', // Classic voxel look for asteroids
                    uvScale: 1.0 
                });
                geo.computeBoundingSphere();
                const br = geo.boundingSphere?.radius ?? 1;
                const normScale = br > 0.00001 ? 1 / br : 1;
                if (normScale !== 1) geo.scale(normScale, normScale, normScale);
                geo.computeBoundingSphere();
                this._voxelAsteroidVariants.push({ geo, filled, voxelSizeOriginal: 1.0, normScale });
            }
        }

        const planetColors = [0xff7733, 0x3366ff, 0x44aa44, 0xaa44ff];
        const planetRange = (V1.spawn.planetRange ?? 3000) * ws;

        // Spawn constraints so you don't start "inside" a huge planet and planets don't clump.
        const playerStart = new THREE.Vector3(0, 0, 0);
        const basePos = this.baseStation?.position ? this.baseStation.position.clone() : new THREE.Vector3(0, 0, -120 * ws);
        const forward0 = new THREE.Vector3(0, 0, 1); // initial ship forward

        /** @type {{ pos: THREE.Vector3, r: number, kind: string }[]} */
        const placed = [];

        const kindRadius = (kind) => {
             if (kind === 'planet_large') return 1500 * ws * 0.5;
             if (kind === 'planet_medium') return 450 * ws * 0.5;
             if (kind === 'planet_small') return 85 * ws * 0.5;
             if (kind === 'asteroid') return 15 * ws * 0.5; // Approx
             return 100 * ws;
        };
        const kindMinFromStart = (kind, r) => {
            // Scale-aware distances: keep a clean "spawn pocket" around the origin.
            // (Old constants were for much smaller planets and became impossible with 1500*ws scale.)
            const pad = kind === 'planet_large' ? 2200 * ws : kind === 'planet_medium' ? 1200 * ws : 650 * ws;
            return r * 1.35 + pad;
        };
        const kindMinFromBase = (kind, r) => {
            // Keep planets away from base so docking area stays readable.
            const pad = kind === 'planet_large' ? 2000 * ws : kind === 'planet_medium' ? 1200 * ws : 850 * ws;
            return r * 1.25 + pad;
        };

        const isOkPos = (pos, kind, r) => {
            // Keep away from player start and base.
            if (pos.distanceTo(playerStart) < kindMinFromStart(kind, r)) return false;
            if (pos.distanceTo(basePos) < kindMinFromBase(kind, r)) return false;

            // Keep planets apart (radius-based).
            const baseSep = kind === 'asteroid' ? 150 * ws : 900 * ws;
            for (const p of placed) {
                const sep = (r + p.r) * 1.1 + baseSep;
                if (pos.distanceTo(p.pos) < sep) return false;
            }

            // Avoid putting giant planets directly in front of the player on spawn.
            const dir = pos.clone().sub(playerStart).normalize();
            const dot = dir.dot(forward0);
            if (kind === 'planet_large' && dot > 0.55 && pos.length() < planetRange * 0.95) return false;

            return true;
        };

        const pickPos = (kind, r) => {
            // Bias large planets towards the outer shell of the spawn cube so they don't dominate the start view.
            const tries = 220;
            for (let t = 0; t < tries; t++) {
                const biasOuter = kind === 'planet_large' ? 0.75 : kind === 'planet_medium' ? 0.55 : 0.35;
                const rr = biasOuter + Math.random() * (1 - biasOuter); // [biasOuter..1]
                const sx = (Math.random() - 0.5) * planetRange * 2 * rr;
                const sy = (Math.random() - 0.5) * planetRange * 2 * rr;
                const sz = (Math.random() - 0.5) * planetRange * 2 * rr;
                const pos = new THREE.Vector3(sx, sy, sz);
                if (isOkPos(pos, kind, r)) return pos;
            }
            // If we can't find a valid placement, skip this planet instead of spawning it too close.
            return null;
        };

        const pickAsteroidPos = (r) => {
            // Asteroids: spawn in a denser, closer belt to ensure visibility.
            const range = 6000 * ws; // Much closer than planets (30000)
            const tries = 100;
            for (let t = 0; t < tries; t++) {
                const rr = 0.15 + Math.random() * 0.85;
                const sx = (Math.random() - 0.5) * range * 2 * rr;
                const sy = (Math.random() - 0.5) * range * 2 * rr;
                const sz = (Math.random() - 0.5) * range * 2 * rr;
                const pos = new THREE.Vector3(sx, sy, sz);
                // Less strict checks for asteroids: allow them closer to player/base than planets
                // but still respect a minimal safety bubble.
                if (pos.distanceTo(playerStart) < 300 * ws) continue;
                if (pos.distanceTo(basePos) < 400 * ws) continue;
                
                // Simple separation check against other objects
                let ok = true;
                const minSep = 80 * ws;
                for (const p of placed) {
                    if (pos.distanceTo(p.pos) < (r + p.r + minSep)) {
                        ok = false;
                        break;
                    }
                }
                if (ok) return pos;
            }
            return null;
        };

        const spawnPlanet = (kind, i) => {
            const color = planetColors[i % planetColors.length];
            const variant = this._voxelPlanetVariants[Math.floor(Math.random() * this._voxelPlanetVariants.length)];
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
            const scale = kind === 'planet_large' ? 1500 * ws : kind === 'planet_small' ? 85 * ws : 450 * ws;
            planet.scale.set(scale, scale, scale);

            const r = kindRadius(kind);
            const ppos = pickPos(kind, r);
            if (!ppos) return;
            planet.position.copy(ppos);
            planet.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

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
                    shadeSide: 0.92,
                    shadeBottom: 0.78,
                    uvMode: this._voxelPlanetVariantsUvMode,
                    uvScale: wantPlanetUvScale
                };
            }

            const hp = V1.targets?.[kind]?.hp ?? V1.targets.planet_medium.hp;
            const planetEntityId = this.world.createObject({ type: 'planet', kind, hp, maxHp: hp });
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

            this._addPlanetBeam(planet, color);

            this._registerDistanceLabel(planet, {
                kind: 'planet',
                prefix: `P${i + 1}-${kind === 'planet_large' ? 'L' : kind === 'planet_small' ? 'S' : 'M'}`,
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

            placed.push({ pos: planet.position.clone(), r, kind });
        };

        const spawnAsteroid = (i) => {
            const variant = this._voxelAsteroidVariants[Math.floor(Math.random() * this._voxelAsteroidVariants.length)];
            // Use asteroid palette
            const color = this.theme.asteroidPalette[Math.floor(Math.random() * this.theme.asteroidPalette.length)];
            const mat = this._voxLit({
                color,
                map: this._voxelTextures.stone ?? this._voxelTextures.rock, // Stone texture
                emissive: 0x000000,
                emissiveIntensity: 0.0
            });
            mat.roughness = 0.9;
            mat.metalness = 0.1;
            
            const asteroid = new THREE.Mesh(variant.geo, mat);
            // Scale varies: 12..25 world units
            const scale = (12 + Math.random() * 13) * ws;
            asteroid.scale.set(scale, scale, scale);

            const r = kindRadius('asteroid');
            const ppos = pickAsteroidPos(r);
            if (!ppos) return;
            asteroid.position.copy(ppos);
            asteroid.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

            asteroid.userData = {
                type: 'asteroid',
                voxel: null
            };

            {
                const filled = new Set(variant.filled);
                asteroid.userData.voxel = {
                    filled,
                    resource: new Set(), // Could add resources later
                    resourceRate: 0,
                    initialCount: filled.size,
                    voxelSizeOriginal: variant.voxelSizeOriginal,
                    normScale: variant.normScale,
                    shadeTop: 1.0,
                    shadeSide: 0.85,
                    shadeBottom: 0.65,
                    uvMode: 'perFace',
                    uvScale: 1.0
                };
            }

            // Health: fragile
            const hp = 60 + Math.random() * 80;
            const entityId = this.world.createObject({ type: 'asteroid', kind: 'asteroid', hp, maxHp: hp });
            this.world.transform.set(entityId, { 
                x: ppos.x, 
                y: ppos.y, 
                z: ppos.z,
                rx: asteroid.rotation.x,
                ry: asteroid.rotation.y,
                rz: asteroid.rotation.z,
                sx: asteroid.scale.x,
                sy: asteroid.scale.y,
                sz: asteroid.scale.z
            });

            // Asteroids rotate faster
            this.world.spin.set(entityId, {
                x: (Math.random() - 0.5) * 0.04,
                y: (Math.random() - 0.5) * 0.04,
                z: (Math.random() - 0.5) * 0.04
            });
            
            this.renderRegistry.bind(entityId, asteroid);
            this.scene.add(asteroid);
            this.objects.push(asteroid);
            placed.push({ pos: ppos, r, kind: 'asteroid' });
        };

        const nSmall = V1.spawn?.planets?.small ?? 0;
        const nMed = V1.spawn?.planets?.medium ?? 0;
        const nLarge = V1.spawn?.planets?.large ?? 0;
        const nAsteroids = 200; // Denser asteroid field

        let idx = 0;
        for (let i = 0; i < nSmall; i++, idx++) spawnPlanet('planet_small', idx);
        for (let i = 0; i < nMed; i++, idx++) spawnPlanet('planet_medium', idx);
        for (let i = 0; i < nLarge; i++, idx++) spawnPlanet('planet_large', idx);
        for (let i = 0; i < nAsteroids; i++, idx++) spawnAsteroid(idx);
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

        // Hold-to-fire support (mouse/touch + backup key).
        // Note: Space key is still handled on keydown for immediate response.
        if (this._fireHeldMouse || this._fireHeldTouch || this.isControlActive('Space') || this.isControlActive('KeyX')) {
            this.combat.shoot();
        }

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

        const entityId = obj?.userData?.entityId ?? null;
        const kind = entityId ? (this.world.objectMeta.get(entityId)?.kind ?? null) : null;
        const cfg = kind ? (V1.targets?.[kind] ?? null) : null;
        const mul = cfg?.explosionMul ?? 1.0;
        const size = (obj.scale.x ?? 1) * mul;
        
        this.soundManager.playExplosion(size);

        // Enhanced explosion visuals
        this.vfx.createExplosion(obj.position, size, obj.userData.type);
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
        if (this._onPointerDown) window.removeEventListener('pointerdown', this._onPointerDown);
        if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
        if (this._onPointerUp) window.removeEventListener('pointercancel', this._onPointerUp);
        if (this._onPointerUp) window.removeEventListener('blur', this._onPointerUp);
        if (this._onContextMenu) window.removeEventListener('contextmenu', this._onContextMenu);
        if (this.mobileControls) this.mobileControls.detach();

        if (this.composer && this.composer.dispose) this.composer.dispose();
        if (this.renderer) this.renderer.dispose();
    }
}
