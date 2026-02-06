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
    }

    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x020205); // Deep space blue/black
        
        // Add space fog for depth and nebula feel
        this.scene.fog = new THREE.FogExp2(0x050510, 0.0008);

        // Camera setup - Reduced FOV to 60 for less distortion
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
        
        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.toneMapping = THREE.ReinhardToneMapping;

        // Post-processing
        const renderScene = new RenderPass(this.scene, this.camera);
        
        const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            1.5, // strength
            0.4, // radius
            0.1  // threshold - lowered to make more things glow
        );
        
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(renderScene);
        this.composer.addPass(bloomPass);

        // Lighting
        const ambientLight = new THREE.AmbientLight(0x404040, 2);
        this.scene.add(ambientLight);
        
        const sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
        sunLight.position.set(100, 100, 100);
        this.scene.add(sunLight);

        // Stars
        this.createStars();
        this.createSpaceDust(); // Add space dust for speed sensation

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
            color: 0x88ccff,
            size: 0.5,
            transparent: true,
            opacity: 0.6,
            sizeAttenuation: true
        });
        
        this.spaceDustPoints = new THREE.Points(dustGeo, dustMat);
        this.scene.add(this.spaceDustPoints);
    }

    createStars() {
        // 1. Background Dust (Tiny stars)
        const starGeometry = new THREE.BufferGeometry();
        const starVertices = [];
        const starColors = [];
        const colorOptions = [
            new THREE.Color(0xffffff), // White
            new THREE.Color(0xaaccff), // Blueish
            new THREE.Color(0xffccaa)  // Reddish
        ];

        for (let i = 0; i < 10000; i++) {
            const x = (Math.random() - 0.5) * 6000;
            const y = (Math.random() - 0.5) * 6000;
            const z = (Math.random() - 0.5) * 6000;
            starVertices.push(x, y, z);
            
            const color = colorOptions[Math.floor(Math.random() * colorOptions.length)];
            starColors.push(color.r, color.g, color.b);
        }
        
        starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starVertices, 3));
        starGeometry.setAttribute('color', new THREE.Float32BufferAttribute(starColors, 3));
        
        const starMaterial = new THREE.PointsMaterial({
            size: 2,
            vertexColors: true,
            transparent: true,
            opacity: 0.8,
            sizeAttenuation: true
        });
        
        const stars = new THREE.Points(starGeometry, starMaterial);
        this.scene.add(stars);

        // 2. Bright Glowing Stars (For Bloom) - Toned down
        const brightGeo = new THREE.BufferGeometry();
        const brightVertices = [];
        
        for(let i=0; i<300; i++) { // Reduced count from 500
            const x = (Math.random() - 0.5) * 6000;
            const y = (Math.random() - 0.5) * 6000;
            const z = (Math.random() - 0.5) * 6000;
            brightVertices.push(x, y, z);
        }
        brightGeo.setAttribute('position', new THREE.Float32BufferAttribute(brightVertices, 3));
        const brightMat = new THREE.PointsMaterial({
            color: 0xaaccff, // Slightly blue tint instead of pure white
            size: 3,         // Reduced from 6
            transparent: true,
            opacity: 0.6,    // Reduced from 1.0
            sizeAttenuation: true
        });
        const brightStars = new THREE.Points(brightGeo, brightMat);
        this.scene.add(brightStars);

        // 3. Procedural Nebula (Soft Clouds)
        this.createNebula();
    }

    createNebula() {
        // Create a soft texture programmatically
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
        gradient.addColorStop(0, 'rgba(255,255,255,0.4)');
        gradient.addColorStop(0.4, 'rgba(255,255,255,0.1)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 64, 64);
        
        const texture = new THREE.CanvasTexture(canvas);
        
        const colors = [0x5500aa, 0x0033aa, 0xaa0044, 0x00aa88]; // Purple, Blue, Magenta, Teal
        const geometry = new THREE.SpriteMaterial({
            map: texture,
            color: 0xffffff,
            transparent: true,
            opacity: 0.08,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        for (let i = 0; i < 60; i++) {
            const color = colors[Math.floor(Math.random() * colors.length)];
            const material = geometry.clone();
            material.color.setHex(color);
            material.opacity = 0.02 + Math.random() * 0.05; // Reduced opacity to prevent whiteout
            
            const sprite = new THREE.Sprite(material);
            const scale = 1000 + Math.random() * 2000;
            sprite.scale.set(scale, scale, 1);
            
            sprite.position.set(
                (Math.random() - 0.5) * 4000,
                (Math.random() - 0.5) * 4000,
                (Math.random() - 0.5) * 4000
            );
            
            this.scene.add(sprite);
        }
    }

    createBaseStation() {
        const geometry = new THREE.TorusKnotGeometry(20, 5, 100, 16);
        const material = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
        this.baseStation = new THREE.Mesh(geometry, material);
        this.baseStation.position.set(0, 0, -100);
        this.scene.add(this.baseStation);
        
        // Add a glow or some indicator
        const light = new THREE.PointLight(0x00ffff, 100, 100);
        light.position.copy(this.baseStation.position);
        this.scene.add(light);
    }

    createPlayerShip() {
        // High-Fidelity "Starfighter" Design
        const group = new THREE.Group();
        
        const mainColor = this.shipData.color;
        const secondaryColor = 0x333333;
        const accentColor = 0xffaa00;

        // 1. Fuselage (Central Body) - Sleek and long
        const fuselageGeo = new THREE.CylinderGeometry(0.5, 1.2, 6, 8);
        fuselageGeo.rotateX(Math.PI / 2);
        const fuselageMat = new THREE.MeshStandardMaterial({ 
            color: mainColor, roughness: 0.3, metalness: 0.8 
        });
        const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
        fuselage.position.z = 0.5;
        group.add(fuselage);

        // Nose Cone
        const noseGeo = new THREE.ConeGeometry(0.5, 3, 8);
        noseGeo.rotateX(Math.PI / 2);
        const nose = new THREE.Mesh(noseGeo, fuselageMat);
        nose.position.z = 5;
        group.add(nose);

        // 2. Cockpit (Bubble Canopy)
        const cockpitGeo = new THREE.CapsuleGeometry(0.7, 1.5, 4, 8);
        cockpitGeo.rotateX(Math.PI / 2);
        const cockpitMat = new THREE.MeshStandardMaterial({ 
            color: 0x111111, 
            roughness: 0.0, 
            metalness: 1.0,
            emissive: 0x00aaff,
            emissiveIntensity: 0.3
        });
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
        const wingMat = new THREE.MeshStandardMaterial({ color: mainColor, roughness: 0.5, metalness: 0.6 });
        
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
        const engineGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 16);
        engineGeo.rotateX(Math.PI / 2);
        const engineMat = new THREE.MeshStandardMaterial({ color: secondaryColor, roughness: 0.4, metalness: 0.7 });
        
        const glowGeo = new THREE.CylinderGeometry(0.4, 0.1, 0.2, 16);
        glowGeo.rotateX(Math.PI / 2);
        const glowMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });

        const createEngine = (x, y, z) => {
            const engine = new THREE.Mesh(engineGeo, engineMat);
            engine.position.set(x, y, z);
            
            // Engine Glow Ring
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.7, 0.1, 8, 16),
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
        const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
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
        
        // Initial position
        this.player.position.set(0, 0, 0);
        
        // Physics State
        this.currentSpeed = 0;
    }

    createEnvironment() {
        // Create asteroids with better variation
        for (let i = 0; i < 300; i++) {
            const asteroidGeo = new THREE.DodecahedronGeometry(1, Math.floor(Math.random() * 2));
            const material = new THREE.MeshStandardMaterial({ 
                color: new THREE.Color().setHSL(Math.random() * 0.1, 0.2, 0.3 + Math.random() * 0.2),
                roughness: 0.8,
                metalness: 0.2
            });
            
            const asteroid = new THREE.Mesh(asteroidGeo, material);
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

        // Create a few "planets" with more detail
        const planetGeo = new THREE.SphereGeometry(1, 64, 64);
        const planetColors = [0xff7733, 0x3366ff, 0x44aa44, 0xaa44ff];
        
        for (let i = 0; i < 8; i++) {
            const color = planetColors[i % planetColors.length];
            const mat = new THREE.MeshStandardMaterial({ 
                color: color,
                roughness: 0.6,
                metalness: 0.4,
                emissive: color,
                emissiveIntensity: 0.1
            });
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
            const atmosphereGeo = new THREE.SphereGeometry(1.1, 32, 32);
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
