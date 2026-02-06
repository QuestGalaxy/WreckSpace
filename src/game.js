import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SoundManager } from './soundManager.js';

export class Game {
    constructor(shipData) {
        this.shipData = shipData;
        this.soundManager = new SoundManager();
        this.canvas = document.getElementById('game-canvas');
        
        // Game State
        this.stats = {
            energy: shipData.energy,
            storage: 0,
            loot: 0,
            maxStorage: shipData.storage
        };
        
        this.keys = {};
        this.objects = [];
        this.bullets = [];
        this.lootItems = [];
        this.particles = [];
        this.cameraShake = 0;
        this.isPaused = false;
        this.lastShotTime = 0;
        this.fireRate = 600; // ms between shots (Slower for more impact)
        
        // Movement smoothing states
        this.rotationVelocity = new THREE.Vector3(0, 0, 0);
        this.strafeVelocity = new THREE.Vector2(0, 0);
        
        // UI Elements
        this.energyEl = document.getElementById('energy-val');
        this.energyBar = document.getElementById('energy-bar');
        this.storageEl = document.getElementById('storage-val');
        this.storageBar = document.getElementById('storage-bar');
        this.maxStorageEl = document.getElementById('max-storage-val');
        this.lootEl = document.getElementById('loot-val');
        this.messagesEl = document.getElementById('messages');
        this.baseMenu = document.getElementById('base-menu');
        this.resumeBtn = document.getElementById('resume-btn');

        this.maxStorageEl.textContent = this.stats.maxStorage;
        this.updateUI();
        
        this.resumeBtn.onclick = () => {
            this.baseMenu.classList.add('hidden');
            this.isPaused = false;
            this.stats.energy = this.shipData.energy;
            this.updateUI();
        };
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
        window.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            if (e.code === 'Space') this.shoot();
        });
        window.addEventListener('keyup', (e) => this.keys[e.code] = false);
        window.addEventListener('resize', () => this.onWindowResize());
        window.addEventListener('mousedown', () => this.shoot());

        // Start Loop
        this.animate();
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
        this.targetSpeed = 0;
        this.rollAngle = 0;
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
                hp: scale * 5,
                maxHp: scale * 5,
                lootValue: Math.floor(scale * 5),
                rotationSpeed: {
                    x: (Math.random() - 0.5) * 0.01,
                    y: (Math.random() - 0.5) * 0.01,
                    z: (Math.random() - 0.5) * 0.01
                }
            };
            
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
                hp: 500,
                maxHp: 500,
                lootValue: 1000
            };
            
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

    createEngineParticle(position, isBoosting) {
        if (!this.particles) this.particles = [];
        
        // Massive boost for "Fire" effect
        const size = isBoosting ? 0.6 : 0.25; 
        const color = isBoosting ? 0x00ffff : 0x0088ff;
        
        const pGeo = new THREE.SphereGeometry(size, 4, 4);
        const pMat = new THREE.MeshBasicMaterial({ 
            color: color,
            transparent: true,
            opacity: isBoosting ? 0.8 : 0.4,
            blending: THREE.AdditiveBlending // Glowing fire effect
        });
        const p = new THREE.Mesh(pGeo, pMat);
        p.position.copy(position);
        
        // Add some random scatter - wider spread when boosting
        const spread = isBoosting ? 0.3 : 0.15;
        p.position.x += (Math.random() - 0.5) * spread;
        p.position.y += (Math.random() - 0.5) * spread;
        p.position.z += (Math.random() - 0.5) * spread;
        
        p.userData = {
            velocity: new THREE.Vector3(0, 0, 0), // Stationary trail
            life: isBoosting ? 25 : 15, // Longer trail when boosting
            isEngineTrail: true
        };
        
        this.scene.add(p);
        this.particles.push(p);
    }

    updateBaseMarker() {
        const marker = document.getElementById('base-marker');
        if (!marker || !this.baseStation) return;

        const dist = this.player.position.distanceTo(this.baseStation.position);
        
        // Update distance text
        const distEl = marker.querySelector('.marker-dist');
        if (distEl) distEl.textContent = `${Math.round(dist)}m`;

        // Screen projection
        const targetPos = this.baseStation.position.clone();
        targetPos.project(this.camera);

        const widthHalf = window.innerWidth / 2;
        const heightHalf = window.innerHeight / 2;

        let x = (targetPos.x * widthHalf) + widthHalf;
        let y = -(targetPos.y * heightHalf) + heightHalf;

        // Check if behind camera or off-screen
        const isBehind = targetPos.z > 1; // Project returns z > 1 if behind near plane (usually)
        // Actually, with standard projection, z is depth.
        // Let's use a robust way: check dot product with camera forward
        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);
        const dirToTarget = new THREE.Vector3().subVectors(this.baseStation.position, this.camera.position).normalize();
        const dot = camDir.dot(dirToTarget);
        
        const isOffScreen = x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight || dot < 0.2;

        if (isOffScreen) {
            marker.classList.add('off-screen');
            
            // Calculate direction from center to target
            // If behind, we invert the position relative to center to show "turn around" direction
            let dx = x - widthHalf;
            let dy = y - heightHalf;

            if (dot < 0) {
                // If behind, invert
                dx = -dx;
                dy = -dy;
            }

            // Normalize direction
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length > 0) {
                dx /= length;
                dy /= length;
            }

            // Clamp to screen edges with padding
            const padding = 40;
            const aspect = window.innerWidth / window.innerHeight;
            
            // Ray intersection with screen box
            // Screen box is from -w/2 to w/2, -h/2 to h/2 (relative to center)
            // Line is P = t * D
            
            // Check vertical edges x = +/- (w/2 - pad)
            const edgeX = widthHalf - padding;
            const edgeY = heightHalf - padding;

            let t = Infinity;
            
            // Check vertical edges
            if (dx !== 0) {
                const tx = (dx > 0 ? edgeX : -edgeX) / dx;
                if (tx > 0) t = Math.min(t, tx);
            }
            
            // Check horizontal edges
            if (dy !== 0) {
                const ty = (dy > 0 ? edgeY : -edgeY) / dy;
                if (ty > 0) t = Math.min(t, ty);
            }

            // Apply calculated position
            x = widthHalf + dx * t;
            y = heightHalf + dy * t;

            // Rotate arrow
            const angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90; // +90 because arrow points up by default
            const arrow = marker.querySelector('.marker-arrow');
            if (arrow) arrow.style.transform = `rotate(${angle}deg)`;

        } else {
            marker.classList.remove('off-screen');
            const arrow = marker.querySelector('.marker-arrow');
            if (arrow) arrow.style.transform = 'none';
        }
        
        marker.style.left = `${x}px`;
        marker.style.top = `${y}px`;
        marker.style.opacity = 1;
    }

    updateTargetLock() {
        // Find best target within cone
        let bestTarget = null;
        let bestAngle = 0.25; // Slightly wider cone
        const maxDist = 500; // Increased range

        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.quaternion).normalize();
        const playerPos = this.player.position;

        for (const obj of this.objects) {
            const dirToObj = new THREE.Vector3().subVectors(obj.position, playerPos);
            const dist = dirToObj.length();
            
            if (dist > maxDist) continue;
            
            dirToObj.normalize();
            const angle = 1 - forward.dot(dirToObj); // 0 means perfectly aligned

            if (angle < bestAngle) {
                bestAngle = angle;
                bestTarget = obj;
            }
        }

        this.currentTarget = bestTarget;
        
        // Visual Feedback & Snapping
        const crosshair = document.getElementById('crosshair-container');
        if (crosshair) {
            if (this.currentTarget) {
                crosshair.classList.add('locked');
                
                // Project target position to screen space
                const targetPos = this.currentTarget.position.clone();
                targetPos.project(this.camera);
                
                const x = (targetPos.x * .5 + .5) * window.innerWidth;
                const y = (targetPos.y * -.5 + .5) * window.innerHeight;
                
                // Apply snapped position
                crosshair.style.left = `${x}px`;
                crosshair.style.top = `${y}px`;
                crosshair.style.transform = 'translate(-50%, -50%) rotate(45deg) scale(0.8)'; // Keep locked rotation
                
            } else {
                crosshair.classList.remove('locked');
                // Reset to center
                crosshair.style.left = '50%';
                crosshair.style.top = '50%';
                crosshair.style.transform = 'translate(-50%, -50%)'; // Reset transform
            }
        }
    }

    shoot() {
        const now = Date.now();
        if (this.isPaused || this.stats.energy <= 0 || now - this.lastShotTime < this.fireRate) return;
        
        // Ensure audio is ready on first interaction
        this.soundManager.init();
        this.soundManager.playShoot();

        this.lastShotTime = now;

        const crosshair = document.getElementById('crosshair-container');
        if (crosshair) {
            crosshair.classList.add('firing');
            setTimeout(() => crosshair.classList.remove('firing'), 100);
        }
        
        // Laser Geometry: Much beefier and longer for "Heavy Laser" feel
        const laserGeo = new THREE.CylinderGeometry(0.25, 0.25, 12, 8); 
        laserGeo.rotateX(Math.PI / 2); 
        
        const laserMat = new THREE.MeshBasicMaterial({ 
            color: 0x00ffff, 
            transparent: true,
            opacity: 1.0,
            blending: THREE.AdditiveBlending 
        });
        const bullet = new THREE.Mesh(laserGeo, laserMat);
        
        // Brighter Core
        const coreGeo = new THREE.CylinderGeometry(0.1, 0.1, 12.2, 8);
        coreGeo.rotateX(Math.PI / 2);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const core = new THREE.Mesh(coreGeo, coreMat);
        bullet.add(core);
        
        // Start exactly at the nose of the ship
        const noseOffset = new THREE.Vector3(0, 0, 2);
        const bulletPos = noseOffset.applyMatrix4(this.player.matrixWorld);
        bullet.position.copy(bulletPos);
        
        // Direction and rotation
        let forward;
        if (this.currentTarget) {
            // Aim Assist: Fire towards target center
            forward = new THREE.Vector3().subVectors(this.currentTarget.position, bulletPos).normalize();
            // Orient bullet to face target
            bullet.lookAt(this.currentTarget.position);
        } else {
            // Standard Fire
            forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.quaternion);
            bullet.quaternion.copy(this.player.quaternion);
        }
        
        bullet.userData = {
            velocity: forward.multiplyScalar(15), // Very fast lasers
            life: 200
        };
        
        this.scene.add(bullet);
        this.bullets.push(bullet);
        
        // Muzzle Flash Effect
        const flashGeo = new THREE.SphereGeometry(0.5, 8, 8);
        const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
        const flash = new THREE.Mesh(flashGeo, flashMat);
        flash.position.copy(bulletPos);
        this.scene.add(flash);
        setTimeout(() => {
            this.scene.remove(flash);
        }, 50);

        // Feedback: Stronger Camera shake on fire
        this.cameraShake = 0.5;
        
        this.updateUI();
    }

    update() {
        if (this.isPaused) return;
        const now = Date.now() * 0.001; // Current time in seconds

        // --- 0. TARGET LOCK SYSTEM & MARKERS ---
        this.updateTargetLock();
        this.updateBaseMarker();

        // --- 1. ADVANCED PHYSICS & MOVEMENT ---
        if (!this.player.userData.velocity) this.player.userData.velocity = new THREE.Vector3();

        const pitchSpeed = 0.010;
        const yawSpeed = 0.010;
        const rollSpeed = 0.015;
        const acceleration = this.keys['KeyZ'] ? 0.08 : 0.04; // Increased acceleration
        const friction = 0.98; // Slightly more drag for control

        // Rotational Input (Direct Control)
        if (this.keys['ArrowUp'] || this.keys['KeyW']) this.player.rotateX(-pitchSpeed);
        if (this.keys['ArrowDown'] || this.keys['KeyS']) this.player.rotateX(pitchSpeed);
        
        if (this.keys['ArrowLeft'] || this.keys['KeyA']) {
            this.player.rotateY(yawSpeed);
            this.player.rotateZ(rollSpeed * 0.6); // Bank into turn
        }
        if (this.keys['ArrowRight'] || this.keys['KeyD']) {
            this.player.rotateY(-yawSpeed);
            this.player.rotateZ(-rollSpeed * 0.6); // Bank into turn
        }
        
        // Manual Roll
        if (this.keys['KeyQ']) this.player.rotateZ(rollSpeed);
        if (this.keys['KeyE']) this.player.rotateZ(-rollSpeed);

        // Velocity & Thrust Calculation
        // Target speed determines the "engine power"
        // Increased base speed significantly for better feel
        const targetSpeedVal = this.keys['KeyZ'] ? 5.0 : 2.5;
        this.currentSpeed = THREE.MathUtils.lerp(this.currentSpeed, targetSpeedVal, 0.05);
        
        const forwardDir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.quaternion);
        
        // Apply Thrust: Adds to velocity vector (Drift Physics)
        // We push the ship in the direction it's facing
        this.player.userData.velocity.add(forwardDir.multiplyScalar(acceleration * this.currentSpeed * 0.1));
        
        // Apply Drag (Friction)
        this.player.userData.velocity.multiplyScalar(friction);
        
        // Apply Velocity to Position
        this.player.position.add(this.player.userData.velocity);

        // Dodge (Side Thrusters) - Adds lateral velocity
        if (this.keys['ShiftLeft'] || this.keys['ShiftRight']) {
            const strafeForce = 0.05;
            if (this.keys['ArrowLeft'] || this.keys['KeyA']) {
                const left = new THREE.Vector3(1, 0, 0).applyQuaternion(this.player.quaternion);
                this.player.userData.velocity.add(left.multiplyScalar(strafeForce));
            }
            if (this.keys['ArrowRight'] || this.keys['KeyD']) {
                const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(this.player.quaternion);
                this.player.userData.velocity.add(right.multiplyScalar(strafeForce));
            }
        }

        // Engine Trails
        if (this.engineOffsets) {
            this.engineOffsets.forEach(offset => {
                const pos = offset.clone().applyMatrix4(this.player.matrixWorld);
                // More consistent trail, density increases with speed
                if (Math.random() > 0.4) {
                    this.createEngineParticle(pos, this.keys['KeyZ']);
                }
            });
        }

        // --- 2. DYNAMIC CAMERA SYSTEM ---
        // Calculate ideal offset (Third Person)
        // Boost pulls camera back significantly
        // Adjusted: Less pullback on boost to keep ship closer
        const offsetZ = this.keys['KeyZ'] ? -30 : -25; // Was -35 vs -25
        const offsetY = this.keys['KeyZ'] ? 12 : 14;   // Was 10 vs 14
        const idealOffset = new THREE.Vector3(0, offsetY, offsetZ);
        
        // Add shake during boost or shooting
        if (this.keys['KeyZ'] || this.cameraShake > 0) {
             const shakeAmt = this.keys['KeyZ'] ? 0.2 : this.cameraShake;
             idealOffset.x += (Math.random() - 0.5) * shakeAmt;
             idealOffset.y += (Math.random() - 0.5) * shakeAmt;
             if (this.cameraShake > 0) this.cameraShake *= 0.9;
        }

        const worldOffset = idealOffset.applyMatrix4(this.player.matrixWorld);
        this.camera.position.lerp(worldOffset, 0.08); // Smooth follow

        // Look slightly ahead of ship
        const lookTarget = new THREE.Vector3(0, 0, 60).applyMatrix4(this.player.matrixWorld);
        this.camera.lookAt(lookTarget);
        
        // Sync Up vector for loops/rolls
        const playerUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.player.quaternion);
        this.camera.up.lerp(playerUp, 0.1);
        
        // Dynamic FOV for speed sensation
        // Reduced values to prevent fisheye/sphere effect
        const targetFOV = this.keys['KeyZ'] ? 70 : 60;
        this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFOV, 0.04);
        this.camera.updateProjectionMatrix();

        // Update Objects (Rotation)
        for (const obj of this.objects) {
            if (obj.userData.rotationSpeed) {
                obj.rotation.x += obj.userData.rotationSpeed.x;
                obj.rotation.y += obj.userData.rotationSpeed.y;
                obj.rotation.z += obj.userData.rotationSpeed.z;
            } else if (obj.userData.type === 'planet') {
                obj.rotation.y += 0.001; // Slow planet rotation
            }
        }

        // Update Bullets
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.position.add(b.userData.velocity);
            b.userData.life--;

            if (b.userData.life <= 0) {
                this.scene.remove(b);
                this.bullets.splice(i, 1);
                continue;
            }

            // Collision with objects
            for (let j = this.objects.length - 1; j >= 0; j--) {
                const obj = this.objects[j];
                if (b.position.distanceTo(obj.position) < obj.scale.x) {
                    // Subtle hit flash
                    if (obj.material) {
                        const originalIntensity = obj.userData.type === 'planet' ? 0.1 : 0;
                        const originalColor = obj.userData.type === 'planet' ? obj.material.color.getHex() : 0x000000;
                        
                        obj.material.emissive.setHex(0xffffff); 
                        obj.material.emissiveIntensity = 0.25; // Significantly reduced for elegance
                        
                        setTimeout(() => {
                            if (obj && obj.material) {
                                obj.material.emissiveIntensity = originalIntensity;
                                obj.material.emissive.setHex(originalColor);
                            }
                        }, 60); 
                    }

                    this.createHitEffect(b.position.clone());
                    this.soundManager.playHit();
                    obj.userData.hp -= this.shipData.weaponPower;
                    
                    // Show and update health bar
                    if (obj.userData.healthBar) {
                        obj.userData.healthBar.sprite.visible = true;
                        this.updateHealthBar(obj);
                        
                        // Hide after 3 seconds of no hits
                        if (obj.userData.hbTimeout) clearTimeout(obj.userData.hbTimeout);
                        obj.userData.hbTimeout = setTimeout(() => {
                            if (obj.userData && obj.userData.healthBar) {
                                obj.userData.healthBar.sprite.visible = false;
                            }
                        }, 3000);
                    }

                    this.scene.remove(b);
                    this.bullets.splice(i, 1);

                    if (obj.userData.hp <= 0) {
                        this.destroyObject(obj, j);
                    }
                    break;
                }
            }
        }

        // Update Loot
        for (let i = this.lootItems.length - 1; i >= 0; i--) {
            const loot = this.lootItems[i];
            
            // 1. Physics: Move based on velocity (Drifting)
            if (loot.userData.velocity) {
                loot.position.add(loot.userData.velocity);
                loot.userData.velocity.multiplyScalar(0.95); // Drag to slow down to a halt
            }

            // 2. Gentle floating animation (Sine wave)
            loot.position.y += Math.sin(now * 2 + loot.userData.driftOffset) * 0.02;

            // 3. Rotation
            loot.rotation.x += loot.userData.rotationSpeed.x;
            loot.rotation.y += loot.userData.rotationSpeed.y;
            loot.rotation.z += loot.userData.rotationSpeed.z;
            
            // Rotate the holographic ring
            const ring = loot.children.find(c => c.userData.isLootRing);
            if (ring) {
                // Keep the ring flat relative to the world Y, but rotating
                // Since it's a child of loot which is rotating, we need to counter-rotate or handle it differently
                // Actually, simplest visual is just local rotation on Z (since we set X to PI/2)
                ring.rotation.z += 0.05; // Faster spin
                
                // Pulsate opacity
                ring.material.opacity = 0.4 + Math.sin(now * 5) * 0.2;
            }
            
            // Magnet effect if close
            const dist = loot.position.distanceTo(this.player.position);
            const magnetRange = 50; // Significantly increased range (was 15)
            
            if (dist < magnetRange) { 
                const dir = new THREE.Vector3().subVectors(this.player.position, loot.position).normalize();
                
                // Accelerate towards player exponentially as it gets closer
                // Stronger pull factor
                const pullFactor = 1 - (dist / magnetRange); // 0 to 1
                const magnetStrength = pullFactor * 2.0; // Much stronger pull (was ~0.7 max)
                
                loot.position.add(dir.multiplyScalar(magnetStrength));
                
                // Also shrink slightly as it gets sucked in
                if (dist < 10) {
                   loot.scale.multiplyScalar(0.9);
                }
            }

            if (dist < 5) { // Increased collection radius (was 3)
                this.collectLoot(loot, i);
            }
        }

        // Update Particles and Fragments
        if (this.particles) {
            for (let i = this.particles.length - 1; i >= 0; i--) {
                const p = this.particles[i];
                
                // Only move if it has velocity
                if (p.userData.velocity) {
                    p.position.add(p.userData.velocity);
                }
                
                if (p.userData.isFragment) {
                    // Fragment physics: rotate and slow down slightly
                    p.rotation.x += p.userData.rotVelocity.x;
                    p.rotation.y += p.userData.rotVelocity.y;
                    p.rotation.z += p.userData.rotVelocity.z;
                    p.userData.velocity.multiplyScalar(0.98);

                    // Add duman/smoke trail to debris
                    if (Math.random() > 0.7) {
                        const smokeGeo = new THREE.SphereGeometry(p.scale.x * 0.5, 4, 4);
                        const smokeMat = new THREE.MeshBasicMaterial({
                            color: 0x666666,
                            transparent: true,
                            opacity: 0.4
                        });
                        const smoke = new THREE.Mesh(smokeGeo, smokeMat);
                        smoke.position.copy(p.position);
                        smoke.userData = {
                            velocity: new THREE.Vector3(0, 0, 0),
                            life: 30,
                            isSmoke: true
                        };
                        this.scene.add(smoke);
                        this.particles.push(smoke);
                    }
                } else if (p.userData.isSmoke) {
                    // Smoke physics: expand and fade
                    p.scale.multiplyScalar(1.02);
                    p.material.opacity *= 0.95;
                } else if (p.userData.isShockwave) {
                    // Shockwave physics
                    const scale = 1 + (40 - p.userData.life) * p.userData.expandSpeed;
                    p.scale.set(scale, scale, scale);
                    p.material.opacity = p.userData.life / 40;
                } else if (p.userData.isFireball) {
                    // Fireball physics
                    p.scale.multiplyScalar(p.userData.expandSpeed);
                    
                    // Color shift: white -> yellow -> orange -> red -> disappear
                    const lifeRatio = p.userData.life / p.userData.initialLife;
                    if (lifeRatio > 0.8) p.material.color.setHex(0xffffff);
                    else if (lifeRatio > 0.6) p.material.color.setHex(0xffff00);
                    else if (lifeRatio > 0.4) p.material.color.setHex(0xffaa00);
                    else p.material.color.setHex(0xff4400);
                    
                    p.material.opacity = lifeRatio;
                } else if (p.userData.isEngineTrail) {
                    p.scale.multiplyScalar(0.9);
                    p.material.opacity *= 0.9;
                } else {
                    // Dust physics: scale down
                    p.scale.multiplyScalar(0.96);
                }

                p.userData.life--;
                if (p.userData.life <= 0) {
                    this.scene.remove(p);
                    this.particles.splice(i, 1);
                }
            }
        }

        // Check Base Station distance
        if (this.player.position.distanceTo(this.baseStation.position) < 30) {
            if (this.stats.storage > 0) {
                this.depositLoot();
            }
        }

        // Update Space Dust (Infinite Field Effect)
        if (this.spaceDustPoints) {
            const positions = this.spaceDustPoints.geometry.attributes.position.array;
            const range = 200; // Half size of the box
            let needsUpdate = false;

            for(let i = 0; i < positions.length; i += 3) {
                // X Axis
                if (positions[i] < this.player.position.x - range) { positions[i] += range * 2; needsUpdate = true; }
                else if (positions[i] > this.player.position.x + range) { positions[i] -= range * 2; needsUpdate = true; }

                // Y Axis
                if (positions[i+1] < this.player.position.y - range) { positions[i+1] += range * 2; needsUpdate = true; }
                else if (positions[i+1] > this.player.position.y + range) { positions[i+1] -= range * 2; needsUpdate = true; }

                // Z Axis
                if (positions[i+2] < this.player.position.z - range) { positions[i+2] += range * 2; needsUpdate = true; }
                else if (positions[i+2] > this.player.position.z + range) { positions[i+2] -= range * 2; needsUpdate = true; }
            }
            
            if (needsUpdate) {
                this.spaceDustPoints.geometry.attributes.position.needsUpdate = true;
            }
        }

        this.updateUI();
    }

    destroyObject(obj, index) {
        // High impact camera shake on destruction
        this.cameraShake = obj.userData.type === 'planet' ? 2.5 : 1.2;
        
        this.soundManager.playExplosion(obj.scale.x);

        // Enhanced explosion visuals
        this.createExplosion(obj.position, obj.scale.x, obj.userData.type);

        // Spawn larger debris fragments instead of just particles
        const fragmentCount = obj.userData.type === 'planet' ? 12 : 5;
        for (let i = 0; i < fragmentCount; i++) {
            const fragSize = (Math.random() * 0.5 + 0.5) * (obj.scale.x * 0.4);
            const fragGeo = new THREE.IcosahedronGeometry(fragSize, 0);
            const fragMat = obj.material.clone();
            const fragment = new THREE.Mesh(fragGeo, fragMat);
            
            fragment.position.copy(obj.position);
            fragment.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            
            fragment.userData = {
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * 1.5,
                    (Math.random() - 0.5) * 1.5,
                    (Math.random() - 0.5) * 1.5
                ),
                rotVelocity: new THREE.Vector3(
                    (Math.random() - 0.5) * 0.1,
                    (Math.random() - 0.5) * 0.1,
                    (Math.random() - 0.5) * 0.1
                ),
                life: 200 + Math.random() * 100,
                isFragment: true
            };
            
            this.scene.add(fragment);
            this.particles.push(fragment); // Using particles array to manage fragments for simplicity
        }

        // Spawn loot
        const count = obj.userData.type === 'planet' ? 20 : 3;
        for (let i = 0; i < count; i++) {
            const isGem = Math.random() > 0.8;
            
            // Enhanced Loot Visuals
            let lootGeo, lootMat;
            
            if (isGem) {
                 // Rare Gem: HUGE Icosahedron
                 lootGeo = new THREE.IcosahedronGeometry(2.0, 0); 
                 lootMat = new THREE.MeshStandardMaterial({ 
                     color: 0x00ffff,
                     emissive: 0x00ffff,
                     emissiveIntensity: 1.5, // Super bright
                     metalness: 0.9,
                     roughness: 0.0
                 });
             } else {
                 // Gold Ingot: HUGE Box
                 lootGeo = new THREE.BoxGeometry(1.5, 0.8, 2.5);
                 lootMat = new THREE.MeshStandardMaterial({ 
                     color: 0xffd700, // Gold
                     emissive: 0xffaa00,
                     emissiveIntensity: 0.8,
                     metalness: 1.0,
                     roughness: 0.2
                 });
             }
 
             const loot = new THREE.Mesh(lootGeo, lootMat);
             loot.position.copy(obj.position);
             
             // Initial burst direction (Wider spread)
             const sprayDir = new THREE.Vector3(
                 (Math.random() - 0.5) * 2, 
                 (Math.random() - 0.5) * 2, 
                 (Math.random() - 0.5) * 2 
             ).normalize().multiplyScalar(Math.random() * 20 + 10); // Faster spread
             
             loot.userData = {
                 value: isGem ? 50 : 10,
                 type: isGem ? 'gem' : 'coin',
                 velocity: sprayDir,
                 rotationSpeed: {
                     x: (Math.random() - 0.5) * 0.15,
                     y: (Math.random() - 0.5) * 0.15,
                     z: (Math.random() - 0.5) * 0.15
                 },
                 driftOffset: Math.random() * 100 
             };
             
             // Massive Glow
             const spriteMat = new THREE.SpriteMaterial({
                 map: this.createGlowTexture(isGem ? '#00ffff' : '#ffaa00'),
                 color: isGem ? 0x00ffff : 0xffaa00,
                 transparent: true,
                 opacity: 0.8, // More opaque
                 blending: THREE.AdditiveBlending
             });
             const glow = new THREE.Sprite(spriteMat);
             glow.scale.set(12, 12, 1); // Huge glow radius
             loot.add(glow);

             // Add Rotating Ring (Indicator style)
             // Much larger radius, very thin tube
             const ringGeo = new THREE.TorusGeometry(isGem ? 3.0 : 2.5, 0.03, 8, 64); 
             const ringMat = new THREE.MeshBasicMaterial({ 
                 color: isGem ? 0x00ffff : 0xffaa00, 
                 transparent: true, 
                 opacity: 0.6, // Slightly more subtle opacity
                 side: THREE.DoubleSide,
                 blending: THREE.AdditiveBlending // Glowy indicator look
             });
             const ring = new THREE.Mesh(ringGeo, ringMat);
             ring.userData = { isLootRing: true }; 
             
             // Billboard behavior for the ring? No, let's keep it 3D but always facing somewhat towards camera or just rotating nicely
             // Actually, let's make it rotate flat like a pickup indicator
             ring.rotation.x = Math.PI / 2; 
             
             loot.add(ring);

             // Add PointLight for real illumination (Expensive but cool)
             if (isGem) {
                 const light = new THREE.PointLight(0x00ffff, 5, 10);
                 loot.add(light);
             }

            this.scene.add(loot);
            this.lootItems.push(loot);
        }

        this.scene.remove(obj);
        this.objects.splice(index, 1);
        this.showMessage(`Exploded ${obj.userData.type.toUpperCase()}!`);
    }

    createGlowTexture(color) {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext('2d');
        const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, color);
        gradient.addColorStop(0.2, color);
        gradient.addColorStop(0.5, 'rgba(0,0,0,0.1)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 32, 32);
        return new THREE.CanvasTexture(canvas);
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
        const hpPercent = object.userData.hp / object.userData.maxHp;
        
        context.clearRect(0, 0, canvas.width, canvas.height);
        
        // Background
        context.fillStyle = 'rgba(0, 0, 0, 0.5)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        // Health bar
        context.fillStyle = hpPercent > 0.5 ? '#00ff00' : (hpPercent > 0.2 ? '#ffff00' : '#ff0000');
        context.fillRect(2, 2, (canvas.width - 4) * hpPercent, canvas.height - 4);
        
        texture.needsUpdate = true;
    }

    createExplosion(position, size, type) {
        if (!this.particles) this.particles = [];
        
        const isPlanet = type === 'planet';
        
        // 1. Core Shockwave (Expanding Ring)
        // For planets: Slower, larger, more complex
        const ringGeo = new THREE.TorusGeometry(size * (isPlanet ? 0.8 : 0.5), isPlanet ? 2 : 0.1, 16, 100);
        const ringMat = new THREE.MeshBasicMaterial({ 
            color: isPlanet ? 0xff4400 : 0xffaa44, 
            transparent: true, 
            opacity: 1,
            blending: THREE.AdditiveBlending 
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(position);
        ring.lookAt(this.camera.position); // Always face camera
        this.scene.add(ring);
        
        ring.userData = {
            isShockwave: true,
            expandSpeed: size * (isPlanet ? 0.05 : 0.1), // Slower expansion for planets
            life: isPlanet ? 80 : 40
        };
        this.particles.push(ring);

        // 1.5 Second Shockwave (Vertical for Planets)
        if (isPlanet) {
            const ring2 = ring.clone();
            ring2.rotation.x = Math.PI / 2;
            ring2.userData.expandSpeed *= 1.2;
            this.scene.add(ring2);
            this.particles.push(ring2);
        }

        // 2. Fireballs (Expanding glowing spheres)
        const fireballCount = isPlanet ? 25 : 5;
        for (let i = 0; i < fireballCount; i++) {
            const fGeo = new THREE.SphereGeometry(size * (isPlanet ? 0.3 : 0.2), 8, 8);
            const fMat = new THREE.MeshBasicMaterial({ 
                color: isPlanet ? (Math.random() > 0.5 ? 0xff0000 : 0xffaa00) : 0xffffff,
                transparent: true,
                opacity: 1.0,
                blending: THREE.AdditiveBlending
            });
            const fireball = new THREE.Mesh(fGeo, fMat);
            fireball.position.copy(position);
            
            // Random direction
            const dir = new THREE.Vector3(
                (Math.random() - 0.5),
                (Math.random() - 0.5),
                (Math.random() - 0.5)
            ).normalize();
            
            fireball.userData = {
                isFireball: true,
                velocity: dir.multiplyScalar(Math.random() * size * (isPlanet ? 0.1 : 0.3)), // Slower spread for planets
                expandSpeed: 1.02 + Math.random() * 0.03,
                life: 40 + Math.random() * 40,
                initialLife: 40 + Math.random() * 40
            };
            
            this.scene.add(fireball);
            this.particles.push(fireball);
        }

        // 3. High Velocity Sparks
        const sparkCount = Math.floor(size * (isPlanet ? 30 : 15));
        for (let i = 0; i < sparkCount; i++) {
            const pGeo = new THREE.BoxGeometry(isPlanet ? 0.5 : 0.2, isPlanet ? 0.5 : 0.2, isPlanet ? 0.5 : 0.2);
            const pMat = new THREE.MeshBasicMaterial({ 
                color: isPlanet ? 0xff8800 : 0xffdd44,
                transparent: true,
                opacity: 1.0
            });
            const p = new THREE.Mesh(pGeo, pMat);
            p.position.copy(position);
            
            p.userData = {
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * size * (isPlanet ? 1.5 : 2.5),
                    (Math.random() - 0.5) * size * (isPlanet ? 1.5 : 2.5),
                    (Math.random() - 0.5) * size * (isPlanet ? 1.5 : 2.5)
                ),
                life: 15 + Math.random() * 20
            };
            
            this.scene.add(p);
            this.particles.push(p);
        }
    }

    createHitEffect(position) {
        if (!this.particles) this.particles = [];
        // Impact Sparks - More subtle and fewer
        for (let i = 0; i < 3; i++) {
            const pGeo = new THREE.SphereGeometry(0.03, 4, 4);
            const pMat = new THREE.MeshBasicMaterial({ 
                color: 0x00ffff,
                transparent: true,
                opacity: 0.5
            });
            const p = new THREE.Mesh(pGeo, pMat);
            p.position.copy(position);
            
            p.userData = {
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * 1.5,
                    (Math.random() - 0.5) * 1.5,
                    (Math.random() - 0.5) * 1.5
                ),
                life: 8 + Math.random() * 8
            };
            
            this.scene.add(p);
            this.particles.push(p);
        }

        // Hitmarker UI
        const crosshair = document.getElementById('crosshair-container');
        if (crosshair) {
            crosshair.classList.remove('hit');
            void crosshair.offsetWidth; // Trigger reflow
            crosshair.classList.add('hit');
            setTimeout(() => crosshair.classList.remove('hit'), 150);
        }

        // Camera Shake
        this.cameraShake = 0.3;
    }

    collectLoot(loot, index) {
        if (this.stats.storage >= this.stats.maxStorage) {
            this.showMessage("Storage Full! Return to base.");
            return;
        }

        this.stats.storage += 1;
        this.stats.loot += loot.userData.value;
        this.soundManager.playCollect();
        this.scene.remove(loot);
        this.lootItems.splice(index, 1);
        this.updateUI();
    }

    depositLoot() {
        this.isPaused = true;
        this.baseMenu.classList.remove('hidden');
        this.stats.storage = 0;
        this.soundManager.playDeposit();
        this.showMessage("Loot deposited! Energy refilled.");
    }

    updateUI() {
        // Energy Update
        const energyPercent = Math.max(0, (this.stats.energy / this.shipData.energy) * 100);
        this.energyEl.textContent = `${Math.floor(energyPercent)}%`;
        if (this.energyBar) {
            this.energyBar.style.width = `${energyPercent}%`;
            // Color change on low energy
            if (energyPercent < 30) this.energyBar.style.background = 'linear-gradient(90deg, #ff0000, #ff4400)';
            else this.energyBar.style.background = 'linear-gradient(90deg, #0088ff, #00ffff)';
        }

        // Storage Update
        this.storageEl.textContent = this.stats.storage;
        if (this.storageBar) {
            const storagePercent = Math.min(100, (this.stats.storage / this.stats.maxStorage) * 100);
            this.storageBar.style.width = `${storagePercent}%`;
            // Color change on near full
            if (storagePercent > 90) this.storageBar.style.background = 'linear-gradient(90deg, #ff8800, #ff0000)';
            else this.storageBar.style.background = 'linear-gradient(90deg, #0088ff, #00ffff)';
        }

        this.lootEl.textContent = this.stats.loot;
        
        if (this.stats.energy <= 0) {
            this.showMessage("Out of Energy! Game Over (Reload to restart)");
            this.isPaused = true;
        }
    }

    showMessage(text) {
        if (text.includes("Full") || text.includes("Out of")) {
             this.soundManager.playError();
        }
        
        // Create styled message element
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message';
        msgDiv.textContent = text;
        
        // Clear previous messages to prevent clutter (or allow stacking if preferred)
        this.messagesEl.innerHTML = ''; 
        this.messagesEl.appendChild(msgDiv);
        
        setTimeout(() => {
            if (this.messagesEl.contains(msgDiv)) {
                msgDiv.style.opacity = '0'; // Trigger fade if not handled by CSS animation end
                setTimeout(() => {
                    if (this.messagesEl.contains(msgDiv)) {
                        this.messagesEl.removeChild(msgDiv);
                    }
                }, 500);
            }
        }, 2500);
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        if (this.composer) {
            this.composer.setSize(window.innerWidth, window.innerHeight);
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.update();
        if (this.composer) {
            this.composer.render();
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }
}
