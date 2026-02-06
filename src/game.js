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
     * @param {{ hud?: import('./ui/hudController.js').HudController }} [deps]
     */
    constructor(shipData, deps = {}) {
        this.shipData = shipData;
        this.soundManager = new SoundManager();
        this.hud = deps.hud ?? null;
        this.canvas = document.getElementById('game-canvas');
        
        // Game State
        this.stats = {
            energy: shipData.energy,
            storage: 0,
            loot: 0,
            maxStorage: shipData.storage
        };
        
        this.input = new KeyboardInput();
        this.keys = this.input.keys;
        this.objects = [];
        this.bullets = [];
        this.particles = [];
        this.cameraShake = 0;
        this.isPaused = false;
        this.lastShotTime = 0;
        this.fireRate = 600; // ms between shots (Slower for more impact)
        this.shotEnergyCost = 2;

        if (this.hud) {
            this.hud.setMaxStorage(this.stats.maxStorage);
            this.hud.setStats({
                energy: this.stats.energy,
                maxEnergy: this.shipData.energy,
                storage: this.stats.storage,
                maxStorage: this.stats.maxStorage,
                loot: this.stats.loot
            });
            this.hud.onResume(() => this.resumeFromBase());
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
            // Brighter rock range; face shading will still add depth.
            asteroidPalette: [0x7c86a3, 0x8a7a84, 0x6b8f92, 0x8b8a6c],
            station: { hull: 0xa6adb8, dark: 0x1b1f2a, light: 0x66ccff },
            ship: { dark: 0x1b1f2a, accent: 0xffaa22, glass: 0x0b1222, thruster: 0x66ccff }
        };
    }

    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = this._createSpaceBackgroundTexture(768);
        // Keep fog subtle; helps distant voxels read without looking realistic.
        // Slightly stronger haze improves depth in space without becoming "smoky".
        this.scene.fog = new THREE.FogExp2(this.theme.fog, 0.00022 / this.worldScale);

        // Camera setup - Reduced FOV to 60 for less distortion
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000 * this.worldScale);
        
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
        this.renderer.toneMappingExposure = 1.28;

        // Post-processing
        const renderScene = new RenderPass(this.scene, this.camera);
        
        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            0.75, // strength
            0.18, // radius
            0.35  // threshold (mostly glows)
        );
        
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(renderScene);
        this.composer.addPass(bloomPass);

        // Lighting
        // Minecraft-ish: simple ambient + key + faint rim.
        // Ambient is intentionally a bit high; Minecraft-like face shading provides the depth.
        const ambientLight = new THREE.AmbientLight(0x9fb7ff, 1.25);
        this.scene.add(ambientLight);

        // Soft "sky vs void" fill improves depth cues (tops read lighter than undersides).
        const hemi = new THREE.HemisphereLight(0xd6ecff, 0x080518, 0.75);
        this.scene.add(hemi);
        
        const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
        sunLight.position.set(120, 160, 90);
        this.scene.add(sunLight);

        const rim = new THREE.DirectionalLight(0x66ccff, 0.35);
        rim.position.set(-120, 20, -180);
        this.scene.add(rim);

        // Camera fill light: prevents "pitch black" faces when the main key is behind.
        // Attach to camera so it always helps what's on screen without flattening everything.
        this.scene.add(this.camera);
        const camFill = new THREE.PointLight(0x9fd9ff, 0.55, 900 * this.worldScale, 2);
        camFill.position.set(0, 0, 0);
        this.camera.add(camFill);

        this._initVoxelTextures();

        // Backdrop
        this.createRetroBackdrop(); // still fine: it's a starfield + nebula sprites
        this.createSpaceDust(); // still useful for speed feel; CRT pass stylizes it

        // Base Station
        this.createBaseStation();

        // Player Spaceship
        this.createPlayerShip();

        // Environment (Asteroids/Planets)
        this.createEnvironment();

        // Controls
        this.input.attach(window);
        this._onKeyDownShoot = (e) => {
            if (e.code === 'Space') this.shoot();
        };
        window.addEventListener('keydown', this._onKeyDownShoot);
        this._onResize = () => this.onWindowResize();
        window.addEventListener('resize', this._onResize);
        this._onMouseDown = () => this.shoot();
        window.addEventListener('mousedown', this._onMouseDown);

        // Start Loop
        requestAnimationFrame((t) => this.animate(t));
    }

    resumeFromBase() {
        if (this.hud) this.hud.setBaseMenuVisible(false);
        this.isPaused = false;
        this.stats.energy = this.shipData.energy;
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

    _voxLit({ color, map = null, emissive = 0x000000, emissiveIntensity = 0.0 } = {}) {
        const mat = new THREE.MeshStandardMaterial({
            color,
            map: map ?? null,
            emissive,
            emissiveIntensity,
            metalness: 0.0,
            roughness: 1.0,
            flatShading: true,
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
            for (let i = 0; i < 10; i++) {
                const rng = mulberry32(0xdecafbad + i * 1013);
                const filled = new Set();
                const r = 2 + Math.floor(rng() * 4); // 2..5 voxels
                addSphere(filled, r, { hollow: false, jitter: 1.25, rng });
                // Chip away a bit to make it rock-like.
                for (const k of Array.from(filled)) {
                    if (rng() < 0.10) filled.delete(k);
                }
                const geo = buildVoxelSurfaceGeometry(filled, {
                    voxelSize: this.voxel.size,
                    shadeTop: 1.0,
                    shadeSide: 0.92,
                    shadeBottom: 0.78
                });
                // Normalize geometry so object scale remains a "radius-ish" number (used by collisions).
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

        // Create asteroids
        const asteroidRange = 2200 * this.worldScale;
        for (let i = 0; i < 320; i++) {
            const variant = this._voxelAsteroidVariants[i % this._voxelAsteroidVariants.length];
            const asteroidColor = this.theme.asteroidPalette[Math.floor(Math.random() * this.theme.asteroidPalette.length)];
            const material = this._voxLit({
                color: asteroidColor,
                map: this._voxelTextures.rock,
                emissive: 0x0b1633,
                emissiveIntensity: 0.10
            });

            const asteroid = new THREE.Mesh(variant.geo, material);
            const scale = (1.2 + Math.random() * 7.5) * this.worldScale;
            asteroid.scale.set(scale, scale, scale);
            
            asteroid.position.set(
                (Math.random() - 0.5) * asteroidRange * 2,
                (Math.random() - 0.5) * asteroidRange * 2,
                (Math.random() - 0.5) * asteroidRange * 2
            );
            
            asteroid.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            
            // Don't place near base
            if (asteroid.position.distanceTo(this.baseStation.position) < 150 * this.worldScale) {
                asteroid.position.x += 300 * this.worldScale;
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

            // Per-instance voxel state for destruction. (Variants share geometry; instances need their own filled set.)
            {
                const filled = new Set(variant.filled);
                const surface = _computeSurfaceKeys(filled);
                const rng = mulberry32(0xabc000 + i * 1777);
                const resourceRate = 0.08;
                const resourceCount = Math.max(2, Math.min(30, Math.floor(surface.length * resourceRate)));
                const picks = _sampleFromArray(surface, resourceCount, rng);
                const resource = new Set(picks);
                asteroid.userData.voxel = {
                    filled,
                    resource,
                    resourceRate,
                    initialCount: filled.size,
                    voxelSizeOriginal: variant.voxelSizeOriginal,
                    normScale: variant.normScale,
                    shadeTop: variant.shadeTop,
                    shadeSide: variant.shadeSide,
                    shadeBottom: variant.shadeBottom,
                    lastRebuildAtSec: -999
                };
            }
            const entityId = this.world.createObject({
                type: 'asteroid',
                hp: scale * 5,
                maxHp: scale * 5,
                lootValue: Math.floor(scale * 5)
            });
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
            
            // Add Health Bar (Initially hidden)
            this.createHealthBar(asteroid);
            
            this.scene.add(asteroid);
            this.objects.push(asteroid);
        }

        // Planets: voxel shells (chunky).
        if (!this._voxelPlanetVariants) {
            this._voxelPlanetVariants = [];
            for (let i = 0; i < 4; i++) {
                const rng = mulberry32(0x12345678 + i * 99991);
                const filled = new Set();
                const r = 11 + Math.floor(rng() * 3); // 11..13 voxels
                addSphere(filled, r, { hollow: true, thickness: 2, jitter: 0.75, rng });
                const geo = buildVoxelSurfaceGeometry(filled, { voxelSize: 1.0 });
                geo.computeBoundingSphere();
                const br = geo.boundingSphere?.radius ?? 1;
                const normScale = br > 0.00001 ? 1 / br : 1;
                if (normScale !== 1) geo.scale(normScale, normScale, normScale);
                geo.computeBoundingSphere();
                this._voxelPlanetVariants.push({ geo, filled, voxelSizeOriginal: 1.0, normScale });
            }
        }

        const planetColors = [0xff7733, 0x3366ff, 0x44aa44, 0xaa44ff];
        
        for (let i = 0; i < 8; i++) {
            const color = planetColors[i % planetColors.length];
            const variant = this._voxelPlanetVariants[i % this._voxelPlanetVariants.length];
            const mat = this._voxLit({ color, map: this._voxelTextures.rock, emissive: 0x000000, emissiveIntensity: 0.0 });
            const planet = new THREE.Mesh(variant.geo, mat);
            const scale = (80 + Math.random() * 120) * this.worldScale;
            planet.scale.set(scale, scale, scale);
            
            planet.position.set(
                (Math.random() - 0.5) * 6000 * this.worldScale,
                (Math.random() - 0.5) * 6000 * this.worldScale,
                (Math.random() - 0.5) * 6000 * this.worldScale
            );
            
            planet.userData = {
                type: 'planet',
                voxel: null
            };

            {
                const filled = new Set(variant.filled);
                const surface = _computeSurfaceKeys(filled);
                const rng = mulberry32(0xfeed000 + i * 991);
                const resourceRate = 0.04;
                const resourceCount = Math.max(8, Math.min(120, Math.floor(surface.length * resourceRate)));
                const picks = _sampleFromArray(surface, resourceCount, rng);
                const resource = new Set(picks);
                planet.userData.voxel = {
                    filled,
                    resource,
                    resourceRate,
                    initialCount: filled.size,
                    voxelSizeOriginal: variant.voxelSizeOriginal,
                    normScale: variant.normScale,
                    shadeTop: 1.0,
                    shadeSide: 0.88,
                    shadeBottom: 0.72,
                    lastRebuildAtSec: -999
                };
            }
            const planetEntityId = this.world.createObject({
                type: 'planet',
                hp: 500,
                maxHp: 500,
                lootValue: 1000
            });
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
            
            // Add Health Bar (Initially hidden)
            this.createHealthBar(planet);
            
            this.scene.add(planet);
            this.objects.push(planet);

            this._registerDistanceLabel(planet, {
                kind: 'planet',
                prefix: `P${i + 1}`,
                yOffset: planet.scale.x * 1.05 + 30 * this.worldScale
            });

            // Simple atmosphere glow (sprite, cheap).
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
            // Sprite is parent-scaled by the planet; keep it small in local space.
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
        this.cameraSystem.update(dtSec, now);
        this.combat.update(dtSec, now);
        this.voxelDestruction.update(dtSec, now);
        this.updateBaseMarker(dtSec, now);

        this.vfx.update(dtSec, now);

        this.loot.update(dtSec, now);
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
            return;
        }

        const idx = this.objects.indexOf(obj);
        if (idx >= 0) {
            this.destroyObject(obj, idx);
            return;
        }

        // Not found in list; still clean up safely.
        this.vfx.createExplosion(obj.position, obj.scale.x, obj.userData.type);
        this.spawner.spawnOnDestroyed(obj);
        this.renderRegistry.unbind(entityId);
        this.world.removeEntity(entityId);
        this.scene.remove(obj);
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


    collectLoot(loot, index) {
        this.loot.collectLoot(loot, index);
    }

    depositLoot() {
        this.loot.depositLoot();
    }

    showMessage(text) {
        const isError = text.includes("Full") || text.includes("Out of");
        if (isError) this.soundManager.playError();
        if (this.hud) this.hud.showMessage(text, { isError });
    }

    updateHudStats() {
        if (!this.hud) return;
        this.hud.setStats({
            energy: this.stats.energy,
            maxEnergy: this.shipData.energy,
            storage: this.stats.storage,
            maxStorage: this.stats.maxStorage,
            loot: this.stats.loot
        });

        if (this.stats.energy <= 0 && !this.isPaused) {
            this.showMessage("Out of Energy! Game Over (Reload to restart)");
            this.isPaused = true;
        }
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
        try {
            this.input.detach(window);
        } catch (_) {
            // ignore
        }
        if (this._onKeyDownShoot) window.removeEventListener('keydown', this._onKeyDownShoot);
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._onMouseDown) window.removeEventListener('mousedown', this._onMouseDown);

        if (this.composer && this.composer.dispose) this.composer.dispose();
        if (this.renderer) this.renderer.dispose();
    }
}
