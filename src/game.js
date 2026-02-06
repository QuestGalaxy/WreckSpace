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
import { World } from './game/world/world.js';
import { RenderRegistry } from './render/syncFromWorld.js';
import { addBox, addSphere, buildVoxelSurfaceGeometry, mulberry32 } from './render/voxel.js';

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

        /** @type {number|null} */
        this.currentTargetEntityId = null;

        /** @type {number|null} */
        this.playerEntityId = null;

        // Visual direction: voxel / Minecraft-ish space.
        this.visual = { mode: 'voxel' };
        this.voxel = {
            size: 1.0
        };
    }

    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0b1022);
        // Keep fog subtle; helps distant voxels read without looking realistic.
        this.scene.fog = new THREE.FogExp2(0x050716, 0.00018);

        // Camera setup - Reduced FOV to 60 for less distortion
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
        
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
        this.renderer.toneMapping = THREE.NoToneMapping;

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
        const ambientLight = new THREE.AmbientLight(0x9fb7ff, 1.1);
        this.scene.add(ambientLight);
        
        const sunLight = new THREE.DirectionalLight(0xffffff, 1.25);
        sunLight.position.set(120, 160, 90);
        this.scene.add(sunLight);

        const rim = new THREE.DirectionalLight(0x66ccff, 0.35);
        rim.position.set(-120, 20, -180);
        this.scene.add(rim);

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
            posArray[i] = (Math.random() - 0.5) * 400; // 400 unit box
        }
        
        dustGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
        
        const dustMat = new THREE.PointsMaterial({
            color: 0x9ad7ff,
            size: 0.7,
            transparent: true,
            opacity: 0.5,
            sizeAttenuation: false
        });
        
        this.spaceDustPoints = new THREE.Points(dustGeo, dustMat);
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
                sizeAttenuation: false
            });
            const points = new THREE.Points(geo, mat);
            this.scene.add(points);
            return { points, range, drift };
        };

        this.retroBackdropLayers = [
            mkLayer({ count: 850, range: 550, size: 2.2, color: 0xcfe3ff, opacity: 0.85, drift: 0.24 }),
            mkLayer({ count: 520, range: 850, size: 2.8, color: 0xa7d0ff, opacity: 0.72, drift: 0.16 }),
            mkLayer({ count: 260, range: 1200, size: 3.3, color: 0xffd2a8, opacity: 0.65, drift: 0.09 })
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
                opacity: 0.14,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const s = new THREE.Sprite(mat);
            const scale = 900 + Math.random() * 1700;
            s.scale.set(scale, scale, 1);
            s.position.set(
                (Math.random() - 0.5) * 3500,
                (Math.random() - 0.5) * 3500,
                (Math.random() - 0.5) * 3500
            );
            s.material.rotation = Math.random() * Math.PI * 2;
            s.userData = { range: 2200 };
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
            buildVoxelSurfaceGeometry(hull, { voxelSize: this.voxel.size }),
            this._voxLit({ color: 0xa6adb8, emissive: 0x0b0c12, emissiveIntensity: 0.08 })
        );
        const darkMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(dark, { voxelSize: this.voxel.size }),
            this._voxLit({ color: 0x1b1f2a, emissive: 0x070814, emissiveIntensity: 0.15 })
        );
        const lightMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(lights, { voxelSize: this.voxel.size }),
            this._voxLit({ color: 0x66ccff, emissive: 0x66ccff, emissiveIntensity: 1.2 })
        );

        group.add(hullMesh, darkMesh, lightMesh);

        this.baseStation = group;
        this.baseStation.position.set(0, 0, -120);
        this.scene.add(this.baseStation);
        
        // Add a glow or some indicator
        const light = new THREE.PointLight(0x00ffff, 65, 90);
        light.position.copy(this.baseStation.position);
        this.scene.add(light);
    }

    _voxLit({ color, emissive = 0x000000, emissiveIntensity = 0.0 } = {}) {
        const mat = new THREE.MeshStandardMaterial({
            color,
            emissive,
            emissiveIntensity,
            metalness: 0.0,
            roughness: 1.0,
            flatShading: true
        });
        return mat;
    }

    createPlayerShip() {
        const group = new THREE.Group();
        
        const mainColor = this.shipData.color ?? 0x44aaff;

        // Voxel model: build separate layers so we can tint materials.
        const hull = new Set();
        const dark = new Set();
        const accent = new Set();
        const glass = new Set();
        const thruster = new Set();

        // Fuselage
        addBox(hull, -1, -1, -6, 1, 1, 6);
        addBox(hull, -2, -1, -3, 2, 1, 2);
        // Nose
        addBox(hull, -1, -1, 7, 1, 1, 10);
        addBox(accent, -1, -2, 6, 1, -2, 10);

        // Wings
        addBox(hull, -6, 0, -2, -3, 0, 4);
        addBox(hull, 3, 0, -2, 6, 0, 4);
        addBox(dark, -7, 0, -1, -6, 0, 3);
        addBox(dark, 6, 0, -1, 7, 0, 3);

        // Cockpit
        addBox(glass, -1, 2, 0, 1, 3, 3);
        addBox(dark, -1, 1, -2, 1, 1, -1);

        // Engines
        addBox(dark, -3, -1, -8, -1, 1, -6);
        addBox(dark, 1, -1, -8, 3, 1, -6);
        addBox(thruster, -2, 0, -9, -2, 0, -9);
        addBox(thruster, 2, 0, -9, 2, 0, -9);

        // Guns
        addBox(accent, -6, 0, 5, -5, 0, 7);
        addBox(accent, 5, 0, 5, 6, 0, 7);

        const hullMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(hull, { voxelSize: this.voxel.size }),
            this._voxLit({ color: mainColor, emissive: 0x0b0b12, emissiveIntensity: 0.08 })
        );
        const darkMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(dark, { voxelSize: this.voxel.size }),
            this._voxLit({ color: 0x1b1f2a, emissive: 0x050512, emissiveIntensity: 0.12 })
        );
        const accentMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(accent, { voxelSize: this.voxel.size }),
            this._voxLit({ color: 0xffaa22, emissive: 0x3a1b00, emissiveIntensity: 0.18 })
        );
        const glassMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(glass, { voxelSize: this.voxel.size }),
            this._voxLit({ color: 0x0b1222, emissive: 0x00aaff, emissiveIntensity: 0.7 })
        );
        const thrusterMesh = new THREE.Mesh(
            buildVoxelSurfaceGeometry(thruster, { voxelSize: this.voxel.size }),
            this._voxLit({ color: 0x66ccff, emissive: 0x66ccff, emissiveIntensity: 2.0 })
        );

        group.add(hullMesh, darkMesh, accentMesh, glassMesh, thrusterMesh);

        // Store engine positions for trails (Tip of the glow)
        this.engineOffsets = [
            new THREE.Vector3(-2, 0, -10),
            new THREE.Vector3(2, 0, -10)
        ];

        this.player = group;
        this.scene.add(this.player);
        
        // Initial position
        this.player.position.set(0, 0, 0);

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
                const geo = buildVoxelSurfaceGeometry(filled, { voxelSize: this.voxel.size });
                // Normalize geometry so object scale remains a "radius-ish" number (used by collisions).
                geo.computeBoundingSphere();
                const br = geo.boundingSphere?.radius ?? 1;
                if (br > 0.00001) geo.scale(1 / br, 1 / br, 1 / br);
                geo.computeBoundingSphere();
                this._voxelAsteroidVariants.push({ geo });
            }
        }

        const asteroidPalette = [
            0x58607a, // blue gray
            0x6a5a62, // warm gray
            0x4f6b6e, // teal gray
            0x5e5d49  // olive gray
        ];

        // Create asteroids
        for (let i = 0; i < 300; i++) {
            const variant = this._voxelAsteroidVariants[i % this._voxelAsteroidVariants.length];
            const asteroidColor = asteroidPalette[Math.floor(Math.random() * asteroidPalette.length)];
            const material = this._voxLit({ color: asteroidColor, emissive: 0x060814, emissiveIntensity: 0.06 });

            const asteroid = new THREE.Mesh(variant.geo, material);
            const scale = 1.2 + Math.random() * 7.5;
            asteroid.scale.set(scale, scale, scale);
            
            asteroid.position.set(
                (Math.random() - 0.5) * 3000,
                (Math.random() - 0.5) * 3000,
                (Math.random() - 0.5) * 3000
            );
            
            asteroid.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            
            // Don't place near base
            if (asteroid.position.distanceTo(this.baseStation.position) < 150) {
                asteroid.position.x += 300;
            }
            
            asteroid.userData = { 
                type: 'asteroid',
                rotationSpeed: {
                    x: (Math.random() - 0.5) * 0.01,
                    y: (Math.random() - 0.5) * 0.01,
                    z: (Math.random() - 0.5) * 0.01
                }
            };
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
                if (br > 0.00001) geo.scale(1 / br, 1 / br, 1 / br);
                geo.computeBoundingSphere();
                this._voxelPlanetVariants.push({ geo });
            }
        }

        const planetColors = [0xff7733, 0x3366ff, 0x44aa44, 0xaa44ff];
        
        for (let i = 0; i < 8; i++) {
            const color = planetColors[i % planetColors.length];
            const variant = this._voxelPlanetVariants[i % this._voxelPlanetVariants.length];
            const mat = this._voxLit({ color, emissive: color, emissiveIntensity: 0.18 });
            const planet = new THREE.Mesh(variant.geo, mat);
            const scale = 80 + Math.random() * 120;
            planet.scale.set(scale, scale, scale);
            
            planet.position.set(
                (Math.random() - 0.5) * 6000,
                (Math.random() - 0.5) * 6000,
                (Math.random() - 0.5) * 6000
            );
            
            planet.userData = {
                type: 'planet',
            };
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
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 16;
        const context = canvas.getContext('2d');
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ 
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        
        const sprite = new THREE.Sprite(material);
         sprite.scale.set(1.5, 0.15, 1); // Much smaller and more elegant
         sprite.position.y = 1.2; // Positioned right above the object
         sprite.visible = false;
        
        object.add(sprite);
        object.userData.healthBar = {
            sprite: sprite,
            canvas: canvas,
            context: context,
            texture: texture
        };
        
        this.updateHealthBar(object);
    }

    updateHealthBar(object) {
        const hb = object.userData.healthBar;
        if (!hb) return;
        
        const { context, canvas, texture } = hb;
        const entityId = object.userData.entityId;
        const h = entityId ? this.world.getHealth(entityId) : null;
        if (!h) return;
        const hpPercent = h.hp / h.maxHp;
        
        context.clearRect(0, 0, canvas.width, canvas.height);
        
        // Background
        context.fillStyle = 'rgba(0, 0, 0, 0.5)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        // Health bar
        context.fillStyle = hpPercent > 0.5 ? '#00ff00' : (hpPercent > 0.2 ? '#ffff00' : '#ff0000');
        context.fillRect(2, 2, (canvas.width - 4) * hpPercent, canvas.height - 4);
        
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
