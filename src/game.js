import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
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
import { RetroCrtShader } from './render/retroCrtShader.js';
import { createToonGradientMap } from './render/toonGradient.js';

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

        // Visual direction: Retro 90s / toon-ish 3D (this branch experiment).
        this.visual = {
            retroEnabled: true,
            crtEnabled: true
        };
    }

    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        // Lift the blacks a lot; CRT pass will add grit via scanlines/mask.
        this.scene.background = new THREE.Color(0x15162c);
        // Reduce realism: keep fog very subtle, more "gamey" than cinematic.
        this.scene.fog = new THREE.FogExp2(0x0a0b1e, 0.00022);

        // Camera setup - Reduced FOV to 60 for less distortion
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
        
        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            // Retro look: let CRT pass control the "pixel" feel, keep AA off.
            antialias: false
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        // Avoid "filmic" realism; keep it simple.
        this.renderer.toneMapping = THREE.NoToneMapping;

        // Post-processing
        const renderScene = new RenderPass(this.scene, this.camera);
        
        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            0.7, // strength (reduced)
            0.2, // radius (reduced)
            0.2  // threshold (reduced glow spam)
        );
        
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(renderScene);
        if (!this.visual.retroEnabled) {
            this.composer.addPass(bloomPass);
        } else {
            // Keep bloom very subtle in retro mode; mostly rely on emissive/additive + CRT.
            this.composer.addPass(bloomPass);
            bloomPass.strength = 0.35;
            bloomPass.radius = 0.1;
            bloomPass.threshold = 0.35;
        }

        // CRT / pixel / quantization pass
        this._retroPass = new ShaderPass(RetroCrtShader);
        this._retroPass.enabled = !!this.visual.crtEnabled;
        this._retroPass.material.uniforms.uResolution.value.set(
            window.innerWidth * window.devicePixelRatio,
            window.innerHeight * window.devicePixelRatio
        );
        // Strong defaults so the CRT/retro look is obvious.
        const dpr = window.devicePixelRatio || 1;
        this._retroPass.material.uniforms.uPixelSize.value = 3.0 * dpr; // ~3 CSS px blocks
        this._retroPass.material.uniforms.uScanline.value = 0.7;
        this._retroPass.material.uniforms.uVignette.value = 0.35;
        this._retroPass.material.uniforms.uCurvature.value = 0.11;
        this._retroPass.material.uniforms.uChroma.value = 1.4 * dpr;
        this._retroPass.material.uniforms.uNoise.value = 0.07;
        this._retroPass.material.uniforms.uMask.value = 0.65;
        this._retroPass.material.uniforms.uLevels.value = 18.0;
        this._retroPass.material.uniforms.uDither.value = 1.0;
        this._retroPass.material.uniforms.uContrast.value = 0.95;
        this._retroPass.material.uniforms.uBrightness.value = 1.28;
        if (this.visual.retroEnabled) this.composer.addPass(this._retroPass);

        // Lighting
        // Stylized lighting: brighter ambient + a single key light.
        const ambientLight = new THREE.AmbientLight(0x8b8bb0, 2.35);
        this.scene.add(ambientLight);
        
        const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
        sunLight.position.set(100, 100, 100);
        this.scene.add(sunLight);

        // Shared toon ramp used by MeshToonMaterial instances.
        this._toonGradientMap = createToonGradientMap();

        // Backdrop
        this.createRetroBackdrop();
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
        // Debug toggles for experimentation on this branch:
        this._onKeyDownVisual = (e) => {
            if (e.code === 'KeyV' && this._retroPass) {
                this._retroPass.enabled = !this._retroPass.enabled;
                this.showMessage(`CRT ${this._retroPass.enabled ? 'ON' : 'OFF'}`);
            }
        };
        window.addEventListener('keydown', this._onKeyDownVisual);
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
        const geometry = new THREE.TorusKnotGeometry(20, 5, 44, 8);
        const material = this._toon({ color: 0x9aa0aa, emissive: 0x1b1b25, emissiveIntensity: 0.15 });
        this.baseStation = new THREE.Mesh(geometry, material);
        this.baseStation.position.set(0, 0, -100);
        this.scene.add(this.baseStation);

        if (this.visual.retroEnabled) this._outlineObject3D(this.baseStation, { opacity: 0.35 });
        
        // Add a glow or some indicator
        const light = new THREE.PointLight(0x00ffff, 65, 90);
        light.position.copy(this.baseStation.position);
        this.scene.add(light);
    }

    _toon({ color, emissive = 0x000000, emissiveIntensity = 0.0 } = {}) {
        return new THREE.MeshToonMaterial({
            color,
            emissive,
            emissiveIntensity,
            gradientMap: this._toonGradientMap
        });
    }

    _outlineObject3D(root, { color = 0x07070c, opacity = 0.45 } = {}) {
        // Cheap "cartoon" outline using edge lines.
        const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
        root.traverse((o) => {
            if (!o.isMesh || !o.geometry) return;
            const edges = new THREE.EdgesGeometry(o.geometry, 35);
            const lines = new THREE.LineSegments(edges, lineMat);
            lines.renderOrder = 999;
            o.add(lines);
        });
    }

    createPlayerShip() {
        // High-Fidelity "Starfighter" Design
        const group = new THREE.Group();
        
        const mainColor = this.shipData.color;
        const secondaryColor = 0x333333;
        const accentColor = 0xffaa00;

        // 1. Fuselage (Central Body) - Sleek and long
        const fuselageGeo = new THREE.CylinderGeometry(0.5, 1.2, 6, 6);
        fuselageGeo.rotateX(Math.PI / 2);
        const fuselageMat = this._toon({ color: mainColor, emissive: 0x0b0b12, emissiveIntensity: 0.12 });
        const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
        fuselage.position.z = 0.5;
        group.add(fuselage);

        // Nose Cone
        const noseGeo = new THREE.ConeGeometry(0.5, 3, 6);
        noseGeo.rotateX(Math.PI / 2);
        const nose = new THREE.Mesh(noseGeo, fuselageMat);
        nose.position.z = 5;
        group.add(nose);

        // 2. Cockpit (Bubble Canopy)
        const cockpitGeo = new THREE.CapsuleGeometry(0.7, 1.5, 3, 6);
        cockpitGeo.rotateX(Math.PI / 2);
        const cockpitMat = this._toon({ color: 0x14141a, emissive: 0x00aaff, emissiveIntensity: 0.35 });
        const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
        cockpit.position.set(0, 0.8, 1.0);
        cockpit.scale.set(1, 0.8, 1);
        group.add(cockpit);

        // 3. Wings (Forward Swept / Aggressive)
        const wingShape = new THREE.Shape();
        wingShape.moveTo(0, 0);
        wingShape.lineTo(4, -2);
        wingShape.lineTo(4, 1);
        wingShape.lineTo(0, 3);
        
        const wingExtrudeSettings = { steps: 1, depth: 0.2, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 2 };
        const wingGeo = new THREE.ExtrudeGeometry(wingShape, wingExtrudeSettings);
        const wingMat = this._toon({ color: mainColor, emissive: 0x0b0b12, emissiveIntensity: 0.08 });
        
        // Left Wing
        const leftWing = new THREE.Mesh(wingGeo, wingMat);
        leftWing.rotation.x = Math.PI / 2;
        leftWing.rotation.y = -0.2; // Slight tilt
        leftWing.position.set(-1, 0, -1);
        group.add(leftWing);

        // Right Wing
        const rightWing = new THREE.Mesh(wingGeo, wingMat);
        rightWing.rotation.x = Math.PI / 2;
        rightWing.rotation.y = Math.PI + 0.2; // Mirror + tilt
        rightWing.position.set(1, 0, -1);
        // Correcting the shape orientation for right wing requires scaling
        rightWing.scale.set(1, 1, -1); // Mirror Z
        rightWing.rotation.set(Math.PI / 2, 0.2, 0);
        group.add(rightWing);

        // 4. Heavy Engines (Double Thrusters)
        const engineGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 8);
        engineGeo.rotateX(Math.PI / 2);
        const engineMat = this._toon({ color: secondaryColor, emissive: 0x070710, emissiveIntensity: 0.15 });
        
        const glowGeo = new THREE.CylinderGeometry(0.4, 0.1, 0.2, 8);
        glowGeo.rotateX(Math.PI / 2);
        const glowMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });

        const createEngine = (x, y, z) => {
            const engine = new THREE.Mesh(engineGeo, engineMat);
            engine.position.set(x, y, z);
            
            // Engine Glow Ring
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.7, 0.1, 6, 10),
                new THREE.MeshBasicMaterial({ color: 0x00ffff, blending: THREE.AdditiveBlending })
            );
            ring.position.z = -1.5;
            engine.add(ring);

            // Inner Glow
            const core = new THREE.Mesh(glowGeo, glowMat);
            core.position.z = -1.5;
            engine.add(core);

            return engine;
        };

        const engL = createEngine(-2.5, 0, -2);
        const engR = createEngine(2.5, 0, -2);
        group.add(engL);
        group.add(engR);

        // 5. Weapon Mounts
        const gunGeo = new THREE.BoxGeometry(0.2, 0.2, 2);
        const gunMat = this._toon({ color: 0x2a2a33, emissive: 0x050507, emissiveIntensity: 0.12 });
        const gunL = new THREE.Mesh(gunGeo, gunMat);
        gunL.position.set(-4, 0, 0);
        const gunR = new THREE.Mesh(gunGeo, gunMat);
        gunR.position.set(4, 0, 0);
        group.add(gunL);
        group.add(gunR);

        // Store engine positions for trails (Tip of the glow)
        this.engineOffsets = [
            new THREE.Vector3(-2.5, 0, -3.5), 
            new THREE.Vector3(2.5, 0, -3.5)
        ];

        this.player = group;
        this.scene.add(this.player);

        if (this.visual.retroEnabled) this._outlineObject3D(this.player, { opacity: 0.35 });
        
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
        // Create asteroids with better variation
        for (let i = 0; i < 300; i++) {
            const asteroidGeo = new THREE.DodecahedronGeometry(1, Math.floor(Math.random() * 2));
            const asteroidColor = new THREE.Color().setHSL(Math.random() * 0.08, 0.22, 0.45);
            const material = this._toon({ color: asteroidColor, emissive: 0x090910, emissiveIntensity: 0.08 });
            
            const asteroid = new THREE.Mesh(asteroidGeo, material);
            asteroid.material.flatShading = true;
            asteroid.material.needsUpdate = true;
            const scale = 1 + Math.random() * 8;
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

        // Planets: keep them chunky/low-poly for the retro-toon direction.
        const planetGeo = new THREE.SphereGeometry(1, 18, 14);
        const planetColors = [0xff7733, 0x3366ff, 0x44aa44, 0xaa44ff];
        
        for (let i = 0; i < 8; i++) {
            const color = planetColors[i % planetColors.length];
            const mat = this._toon({ color, emissive: color, emissiveIntensity: 0.12 });
            const planet = new THREE.Mesh(planetGeo, mat);
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

            // Add a simple atmosphere glow effect for planets
            const atmosphereGeo = new THREE.SphereGeometry(1.1, 14, 10);
            const atmosphereMat = new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: 0.1,
                side: THREE.BackSide
            });
            const atmosphere = new THREE.Mesh(atmosphereGeo, atmosphereMat);
            planet.add(atmosphere);
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
        if (this._retroPass) {
            this._retroPass.material.uniforms.uResolution.value.set(
                window.innerWidth * window.devicePixelRatio,
                window.innerHeight * window.devicePixelRatio
            );
        }
    }

    animate(nowMs) {
        requestAnimationFrame((t) => this.animate(t));
        this._loop.advance(nowMs, (dtSec) => this.update(dtSec));
        if (this._retroPass) this._retroPass.material.uniforms.uTime.value = nowMs / 1000;
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
        if (this._onKeyDownVisual) window.removeEventListener('keydown', this._onKeyDownVisual);
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._onMouseDown) window.removeEventListener('mousedown', this._onMouseDown);

        if (this.composer && this.composer.dispose) this.composer.dispose();
        if (this.renderer) this.renderer.dispose();
    }
}
