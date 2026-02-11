import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { createVoxelTextures } from '../render/voxelTextures.js';
import { createVoxelShipModel } from '../render/voxelShipFactory.js';
import { spaceships } from '../spaceshipData.js';

export class EntryScene {
    constructor({ canvas, onStart }) {
        this.canvas = canvas;
        this.onStart = onStart;
        
        this._raf = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.composer = null;
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        
        this.voxels = []; // Array of { mesh, velocity, initialPos, isActive }
        this.instancedMesh = null;
        this.dummy = new THREE.Object3D();
        
        // Dogfight actors
        this.ships = []; // { mesh, type, t, offset, speed }
        this.lasers = []; // { mesh, velocity, life }
        
        // Configuration
        this.voxelSize = 4.0;
        this.textScale = 0.5;
        
        this.planet = null;
        this.planetVoxels = null; // InstancedMesh
        this.planetVoxelData = []; // { pos, isVisible }
        this.planetAttackers = [];
        this.planetImpacts = []; // { mesh, life }
        
        this.cameraBasePos = new THREE.Vector3(0, 0, 250); // Base camera position
        
        this.asteroids = []; // { group, radius, voxels: [{relPos, color}] }
        this.looseVoxels = []; // { mesh, velocity, rotVel, life }
        
        this._binds = {
            onResize: this._onResize.bind(this),
            onPointerDown: this._onPointerDown.bind(this),
            onPointerMove: this._onPointerMove.bind(this)
        };
    }

    init() {
        this._initThree();
        this._createSpaceBackground();
        this._createPlanet();
        this._createPlanetAttackers();
        this._createAsteroids();
        this._createVoxelTitle("WreckSpace");
        this._createDogfight();
        
        // Initial resize to set camera pos
        this._onResize();
        
        window.addEventListener('resize', this._binds.onResize);
        window.addEventListener('pointerdown', this._binds.onPointerDown);
        window.addEventListener('pointermove', this._binds.onPointerMove);
        
        this._lastTime = performance.now();
        this._raf = requestAnimationFrame(this._animate.bind(this));
    }

    dispose() {
        if (this._raf) cancelAnimationFrame(this._raf);
        
        window.removeEventListener('resize', this._binds.onResize);
        window.removeEventListener('pointerdown', this._binds.onPointerDown);
        window.removeEventListener('pointermove', this._binds.onPointerMove);
        
        if (this.renderer) {
            this.renderer.dispose();
        }
        if (this.composer) {
            this.composer.dispose();
        }
        
        // Clean up scene
        this.scene.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                else obj.material.dispose();
            }
        });
    }

    _initThree() {
        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: false,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x050508);
        this.scene.fog = new THREE.FogExp2(0x050508, 0.002);

        // Camera
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, 0, 250);

        // Post-processing
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        
        const bloom = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            1.5, // strength
            0.4, // radius
            0.85 // threshold
        );
        this.composer.addPass(bloom);

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambient);
        
        const dirLight = new THREE.DirectionalLight(0xffaa00, 2);
        dirLight.position.set(50, 50, 100);
        this.scene.add(dirLight);
        
        const blueLight = new THREE.DirectionalLight(0x0088ff, 2);
        blueLight.position.set(-50, -20, 50);
        this.scene.add(blueLight);
    }

    _createSpaceBackground() {
        // Stars
        const starGeo = new THREE.BufferGeometry();
        const starCount = 2000;
        const posArray = new Float32Array(starCount * 3);
        
        for(let i = 0; i < starCount * 3; i++) {
            posArray[i] = (Math.random() - 0.5) * 600;
        }
        
        starGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
        
        const starMat = new THREE.PointsMaterial({
            size: 2,
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            sizeAttenuation: true
        });
        
        this.starSystem = new THREE.Points(starGeo, starMat);
        this.scene.add(this.starSystem);

        // Add some "Nebula" cubes (distant large voxels)
        const nebulaCount = 50;
        const nebulaGeo = new THREE.BoxGeometry(10, 10, 10);
        const nebulaMat = new THREE.MeshBasicMaterial({ 
            color: 0x4400ff, 
            wireframe: true,
            transparent: true,
            opacity: 0.1
        });
        
        for(let i=0; i<nebulaCount; i++) {
            const mesh = new THREE.Mesh(nebulaGeo, nebulaMat);
            mesh.position.set(
                (Math.random() - 0.5) * 400,
                (Math.random() - 0.5) * 400,
                (Math.random() - 0.5) * 200 - 100
            );
            mesh.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, 0);
            this.scene.add(mesh);
        }
    }

    _createPlanet() {
        // Voxel Planet using InstancedMesh
        const planetRadius = 320; // Even larger (was 280)
        const voxelSize = 12; // Large chunks
        const center = new THREE.Vector3(250, 50, -450); // Closer (was -500)
        
        const textures = createVoxelTextures();
        const material = new THREE.MeshStandardMaterial({
            map: textures.stone,
            color: 0x882222, // Much brighter red (was 0x551111)
            emissive: 0x440000, // Stronger glow (was 0x220000)
            emissiveIntensity: 0.5, // Much brighter (was 0.2)
            roughness: 0.8, // Slightly less rough to catch light
            metalness: 0.2
        });
        
        const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
        
        // Generate positions for a hollow sphere
        const positions = [];
        const resolution = 2.0; // Higher = more dense sampling
        
        // Scan a grid around the sphere
        // To save iterations, we scan in spherical coords
        const steps = Math.floor(Math.PI * planetRadius / voxelSize * resolution);
        
        // Using Golden Spiral for uniform sphere distribution
        const numVoxels = 5000; // Target count
        const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle
        
        this.planetVoxelData = [];
        
        for (let i = 0; i < numVoxels; i++) {
            const y = 1 - (i / (numVoxels - 1)) * 2; // y goes from 1 to -1
            const radiusAtY = Math.sqrt(1 - y * y); // Radius at y
            
            const theta = phi * i;
            
            const x = Math.cos(theta) * radiusAtY;
            const z = Math.sin(theta) * radiusAtY;
            
            // Add some noise to radius for "voxel terrain" look
            const r = planetRadius + (Math.random() - 0.5) * 20;
            
            const pos = new THREE.Vector3(x * r, y * r, z * r).add(center);
            
            // Align to grid to look like voxels
            pos.x = Math.round(pos.x / voxelSize) * voxelSize;
            pos.y = Math.round(pos.y / voxelSize) * voxelSize;
            pos.z = Math.round(pos.z / voxelSize) * voxelSize;
            
            // Avoid duplicates (simple check)
            // Ideally we'd use a Set of strings, but this is simple enough
            // Since we spiral, duplicates are rare if we scale right.
            // But grid snapping might cause overlap.
            
            positions.push(pos);
            this.planetVoxelData.push({
                pos: pos,
                originalPos: pos.clone(),
                isVisible: true,
                index: i
            });
        }
        
        this.planetVoxels = new THREE.InstancedMesh(geometry, material, positions.length);
        
        const dummy = new THREE.Object3D();
        positions.forEach((pos, i) => {
            dummy.position.copy(pos);
            dummy.rotation.set(0,0,0); // Voxel grid aligned
            dummy.updateMatrix();
            this.planetVoxels.setMatrixAt(i, dummy.matrix);
        });
        
        this.planetVoxels.instanceMatrix.needsUpdate = true;
        this.scene.add(this.planetVoxels);
        
        // Add an atmosphere glow (keep this as a smooth mesh for contrast)
        const atmoGeo = new THREE.IcosahedronGeometry(340, 3); // Larger (was 300)
        const atmoMat = new THREE.MeshBasicMaterial({
            color: 0xff6600, // Even brighter orange
            transparent: true,
            opacity: 0.3, // Much more visible (was 0.15)
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending
        });
        const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
        atmosphere.position.copy(center);
        this.scene.add(atmosphere);
        
        // Store planet object for other references (center position mostly)
        this.planet = new THREE.Object3D();
        this.planet.position.copy(center);
        this.planet.add(atmosphere); // Parent atmosphere to it for easy rotation
        this.scene.add(this.planet);
    }
    
    _damagePlanet(targetPos) {
        if (!this.planetVoxels) return;
        
        // Find closest visible voxel
        let closestDist = Infinity;
        let closestIdx = -1;
        
        // Optimization: Only check if distance is reasonable
        // Simple linear search is fast enough for 5000 items in JS
        for (let i = 0; i < this.planetVoxelData.length; i++) {
            const v = this.planetVoxelData[i];
            if (!v.isVisible) continue;
            
            const d = v.pos.distanceToSquared(targetPos);
            if (d < closestDist) {
                closestDist = d;
                closestIdx = i;
            }
        }
        
        // If close enough (hit)
        if (closestIdx !== -1 && closestDist < 2500) { // 50^2
            const v = this.planetVoxelData[closestIdx];
            v.isVisible = false;
            
            // Hide instance
            const dummy = new THREE.Object3D();
            dummy.scale.set(0,0,0);
            dummy.updateMatrix();
            this.planetVoxels.setMatrixAt(closestIdx, dummy.matrix);
            this.planetVoxels.instanceMatrix.needsUpdate = true;
            
            // Spawn debris
            this._spawnPlanetDebris(v.pos);
        }
    }
    
    _spawnPlanetDebris(pos) {
         const fragmentCount = 3 + Math.floor(Math.random() * 3);
         const textures = createVoxelTextures();
         const fragMat = new THREE.MeshStandardMaterial({
             map: textures.stone,
             color: 0x551111,
             roughness: 0.9,
             metalness: 0.1
         });
         
         const planetCenter = this.planet.position;
         const normal = new THREE.Vector3().subVectors(pos, planetCenter).normalize();
         
         for(let i=0; i<fragmentCount; i++) {
              const fragSize = 6.0 + Math.random() * 4.0;
              const frag = new THREE.Mesh(
                  new THREE.BoxGeometry(fragSize, fragSize, fragSize),
                  fragMat
              );
              
              frag.position.copy(pos).add(new THREE.Vector3(
                  (Math.random()-0.5)*5,
                  (Math.random()-0.5)*5,
                  (Math.random()-0.5)*5
              ));
              
              frag.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
              
              this.scene.add(frag);
              
              const vel = normal.clone();
              vel.x += (Math.random()-0.5) * 1.0;
              vel.y += (Math.random()-0.5) * 1.0;
              vel.z += (Math.random()-0.5) * 1.0;
              vel.normalize().multiplyScalar(30 + Math.random() * 30);
              
              this.looseVoxels.push({
                  mesh: frag,
                  velocity: vel,
                  rotVel: new THREE.Vector3(
                      (Math.random()-0.5)*3,
                      (Math.random()-0.5)*3,
                      (Math.random()-0.5)*3
                  ),
                  life: 3.0 + Math.random() * 2.0
              });
         }
         
         // Impact flash
        const geo = new THREE.SphereGeometry(15, 8, 8);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffaa00,
            transparent: true,
            opacity: 1.0
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(pos);
        this.scene.add(mesh);
        this.planetImpacts.push({ mesh, life: 0.5 });
    }

    _createPlanetAttackers() {
        const textures = createVoxelTextures();
        const voxLit = (opts) => new THREE.MeshStandardMaterial({
            color: opts.color,
            map: opts.map ?? null,
            emissive: opts.emissive ?? 0x000000,
            emissiveIntensity: opts.emissiveIntensity ?? 0,
            metalness: 0.5,
            roughness: 0.4
        });
        
        const theme = { ship: { dark: 0x222222, accent: 0xff0000, glass: 0xffaa00, thruster: 0x00ffff } }; // Bad guy colors
        
        const shipData = spaceships.find(s => s.id === 'balanced') || spaceships[0];
        
        // 3 Attackers
        for (let i = 0; i < 3; i++) {
            const model = createVoxelShipModel({
                shipData: shipData,
                voxelSize: 3.0, // Large and menacing
                textures,
                theme,
                voxLit
            });
            
            this.scene.add(model.group);
            
            // Position relative to planet
            // Orbiting around it slightly
            const angle = (i / 3) * Math.PI * 2;
            const dist = 350; // Distance from planet center
            
            const x = this.planet.position.x + Math.cos(angle) * dist;
            const y = this.planet.position.y + Math.sin(angle) * dist * 0.5;
            const z = this.planet.position.z + 150; // In front of planet
            
            model.group.position.set(x, y, z);
            model.group.lookAt(this.planet.position); // Face the planet
            
            this.planetAttackers.push({
                mesh: model.group,
                angle: angle,
                speed: 0.1 + Math.random() * 0.1,
                dist: dist,
                nextFire: Math.random() * 2.0
            });
        }
    }

    _createAsteroids() {
        const count = 8;
        const textures = createVoxelTextures();
        const mat = new THREE.MeshStandardMaterial({
            map: textures.stone,
            color: 0x888888,
            roughness: 0.9,
            metalness: 0.1
        });
        
        for(let i=0; i<count; i++) {
            const group = new THREE.Group();
            const voxels = [];
            const size = 3 + Math.floor(Math.random() * 4); // Radius in voxels
            
            // Create a voxel ball
            for(let x=-size; x<=size; x++) {
                for(let y=-size; y<=size; y++) {
                    for(let z=-size; z<=size; z++) {
                        if (x*x + y*y + z*z <= size*size) {
                            if (Math.random() > 0.7) continue; // Noise
                            
                            const vGeo = new THREE.BoxGeometry(this.voxelSize, this.voxelSize, this.voxelSize);
                            const mesh = new THREE.Mesh(vGeo, mat);
                            mesh.position.set(x*this.voxelSize, y*this.voxelSize, z*this.voxelSize);
                            mesh.castShadow = true;
                            mesh.receiveShadow = true;
                            
                            group.add(mesh);
                            voxels.push({
                                relPos: new THREE.Vector3(x*this.voxelSize, y*this.voxelSize, z*this.voxelSize),
                                color: 0x888888
                            });
                        }
                    }
                }
            }
            
            // Random position in the dogfight area
            group.position.set(
                (Math.random()-0.5) * 300,
                (Math.random()-0.5) * 150,
                (Math.random()-0.5) * 100 - 20
            );
            
            group.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, 0);
            
            this.scene.add(group);
            this.asteroids.push({
                group,
                radius: size * this.voxelSize * 1.5, // Approx bounds
                voxels,
                rotVel: new THREE.Vector3((Math.random()-0.5)*0.5, (Math.random()-0.5)*0.5, (Math.random()-0.5)*0.5)
            });
        }
    }

    _explodeAsteroid(asteroid, impactPoint, forceDir) {
        // Remove original group
        this.scene.remove(asteroid.group);
        
        // Spawn loose voxels
        const textures = createVoxelTextures();
        const mat = new THREE.MeshStandardMaterial({
            map: textures.stone,
            color: 0x888888,
            roughness: 0.9,
            metalness: 0.1
        });
        
        asteroid.voxels.forEach(v => {
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(this.voxelSize, this.voxelSize, this.voxelSize),
                mat
            );
            
            // Transform local pos to world
            mesh.position.copy(v.relPos);
            mesh.position.applyMatrix4(asteroid.group.matrixWorld);
            mesh.rotation.copy(asteroid.group.rotation);
            
            this.scene.add(mesh);
            
            // Calculate explosion velocity
            const vel = new THREE.Vector3().subVectors(mesh.position, impactPoint).normalize();
            vel.addScaledVector(forceDir, 0.5); // Add impact direction
            vel.multiplyScalar(10 + Math.random() * 20); // Boom speed
            
            this.looseVoxels.push({
                mesh,
                velocity: vel,
                rotVel: new THREE.Vector3((Math.random()-0.5)*5, (Math.random()-0.5)*5, (Math.random()-0.5)*5),
                life: 3.0 + Math.random() * 2.0
            });
        });
        
        // Remove from asteroids list
        const idx = this.asteroids.indexOf(asteroid);
        if (idx > -1) this.asteroids.splice(idx, 1);
        
        // SFX visual (Flash)
        const light = new THREE.PointLight(0xffaa00, 5, 100);
        light.position.copy(asteroid.group.position);
        this.scene.add(light);
        setTimeout(() => this.scene.remove(light), 100);
    }

    _createVoxelTitle(text) {
        // Create offscreen canvas to render text
        const cvs = document.createElement('canvas');
        const ctx = cvs.getContext('2d');
        const fontSize = 100;
        cvs.width = 1024;
        cvs.height = 256;
        
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, cvs.width, cvs.height);
        
        ctx.font = `900 ${fontSize}px "Segoe UI", sans-serif`;
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cvs.width / 2, cvs.height / 2);
        
        const imgData = ctx.getImageData(0, 0, cvs.width, cvs.height);
        const pixels = imgData.data;
        
        const voxelPositions = [];
        const step = 4; // Sample every n pixels to keep voxel count manageable
        
        for (let y = 0; y < cvs.height; y += step) {
            for (let x = 0; x < cvs.width; x += step) {
                const i = (y * cvs.width + x) * 4;
                if (pixels[i] > 128) { // If pixel is bright
                    voxelPositions.push({
                        x: (x - cvs.width / 2) * this.textScale,
                        y: -(y - cvs.height / 2) * this.textScale, // Invert Y
                        z: 0
                    });
                }
            }
        }
        
        // Create InstancedMesh
        const geometry = new THREE.BoxGeometry(this.voxelSize * this.textScale, this.voxelSize * this.textScale, this.voxelSize * this.textScale);
        
        // Use game textures for authentic look
        const textures = createVoxelTextures();
        const material = new THREE.MeshStandardMaterial({
            map: textures.panels,
            color: 0xffffff, // White base to allow instance colors to show through
            roughness: 0.5, // Balanced roughness
            metalness: 0.2, // Slight metalness
            emissive: 0x000000, // Pure black emissive (no grey wash)
            emissiveIntensity: 0
        });

        this.instancedMesh = new THREE.InstancedMesh(geometry, material, voxelPositions.length);
        
        const color = new THREE.Color();
        // Neon Cyberpunk Theme - Black Base
        const baseColor = new THREE.Color(0x050505); // Almost Pure Black
        const accentColor1 = new THREE.Color(0xff00cc); // Neon Pink
        const accentColor2 = new THREE.Color(0x00ffff); // Neon Cyan
        const accentColor3 = new THREE.Color(0x4400cc); // Electric Purple
        
        // Add a dedicated DirectionalLight for the title to make it pop consistently
        const titleLight = new THREE.DirectionalLight(0xffffff, 4.0); // Bright white light to hit the black edges
        titleLight.position.set(0, 50, 100); // Frontal-top
        titleLight.target.position.set(0, 0, 0);
        this.scene.add(titleLight);
        this.scene.add(titleLight.target);

        this.voxels = voxelPositions.map((pos, idx) => {
            this.dummy.position.set(pos.x, pos.y, pos.z);
            this.dummy.updateMatrix();
            this.instancedMesh.setMatrixAt(idx, this.dummy.matrix);
            
            // Color Logic
            const rand = Math.random();
            if (rand > 0.90) {
                color.copy(accentColor1); // Neon Pink accents
            } else if (rand > 0.82) {
                color.copy(accentColor2); // Neon Cyan accents
            } else if (rand > 0.65) {
                color.copy(accentColor3); // Electric Purple
            } else {
                // Base Gradient (Black to Dark Grey)
                const t = (pos.x + 300) / 600; 
                color.copy(baseColor).lerp(new THREE.Color(0x1a1a1a), t * 0.4);
            }
            
            this.instancedMesh.setColorAt(idx, color);
            
            return {
                index: idx,
                pos: new THREE.Vector3(pos.x, pos.y, pos.z),
                initialPos: new THREE.Vector3(pos.x, pos.y, pos.z),
                velocity: new THREE.Vector3(0, 0, 0),
                rotation: new THREE.Vector3(0, 0, 0),
                rotationVel: new THREE.Vector3(0, 0, 0),
                isFloating: true // If false, it's been shot
            };
        });
        
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        if (this.instancedMesh.instanceColor) this.instancedMesh.instanceColor.needsUpdate = true;
        this.scene.add(this.instancedMesh);
    }

    _createDogfight() {
        const textures = createVoxelTextures();
        const voxLit = (opts) => new THREE.MeshStandardMaterial({
            color: opts.color,
            map: opts.map ?? null,
            emissive: opts.emissive ?? 0x000000,
            emissiveIntensity: opts.emissiveIntensity ?? 0,
            metalness: 0.5,
            roughness: 0.4
        });
        
        const theme = { ship: { dark: 0x222222, accent: 0xffaa00, glass: 0x00aaff, thruster: 0xff4400 } };
        
        // Target Ship (Miner or Balanced - bulky victim)
        const targetShipData = spaceships.find(s => s.id === 'miner') || spaceships[1];
        const targetModel = createVoxelShipModel({
            shipData: targetShipData,
            voxelSize: 2.0, // Smaller scale for background
            textures,
            theme,
            voxLit
        });
        this.scene.add(targetModel.group);
        this.ships.push({
            mesh: targetModel.group,
            model: targetModel,
            type: 'target',
            t: 0.5, // Start further ahead
            speed: 0.15, // Slightly slower overall speed for mass
            pathOffset: 0
        });
        
        // Chaser Ship (Scout - agile aggressor)
        const chaserShipData = spaceships.find(s => s.id === 'scout') || spaceships[0];
        const chaserModel = createVoxelShipModel({
            shipData: chaserShipData,
            voxelSize: 2.0,
            textures,
            theme,
            voxLit
        });
        this.scene.add(chaserModel.group);
        this.ships.push({
            mesh: chaserModel.group,
            model: chaserModel,
            type: 'chaser',
            t: 0.0, // Significant gap
            speed: 0.15, // Matched base speed
            pathOffset: 0
        });
    }

    _getDogfightPosition(t) {
        // Full 3D "Lissajous" Knot
        // Fills the volume [-200, 200] in all axes
        const time = t * 0.3; // Base speed
        const scale = 220;
        
        // Frequencies (prime numbers to avoid repetition)
        const fx = 3;
        const fy = 5; // High vertical frequency for "loops"
        const fz = 4;
        
        const x = Math.sin(time * fx) * scale;
        const y = Math.sin(time * fy) * scale * 0.8; // Almost full height
        const z = Math.sin(time * fz) * scale - 50;  // Centered slightly back
        
        return new THREE.Vector3(x, y, z);
    }
    
    _spawnLaser(origin, target, color = 0xff0000) {
        // Blaster bolt visual - long glowing core
        const geo = new THREE.CylinderGeometry(0.5, 0.5, 12, 4);
        geo.rotateX(Math.PI / 2); // Align with Z
        
        const mat = new THREE.MeshBasicMaterial({ 
            color: color,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(origin);
        mesh.lookAt(target);
        
        const direction = new THREE.Vector3().subVectors(target, origin).normalize();
        const velocity = direction.multiplyScalar(600); // Very Fast
        
        this.scene.add(mesh);
        
        // Add a point light to the bolt for glow on voxels
        const light = new THREE.PointLight(color, 2, 50);
        mesh.add(light);
        
        this.lasers.push({ mesh, velocity, life: 1.5 });
    }

    _onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
        
        // Responsive Layout Logic
        const isMobile = window.innerWidth < 768;
        const aspect = this.camera.aspect;
        
        let targetWidth = 550; // Desktop width of text
        
        if (isMobile) {
            // Scale title down on mobile
            // This prevents camera from having to move too far back
            if (this.instancedMesh) {
                this.instancedMesh.scale.setScalar(0.7); // Slightly larger (was 0.5)
                this.instancedMesh.position.y = 65; // Adjusted height
            }
            targetWidth = 385; // 0.7 * 550
        } else {
            if (this.instancedMesh) {
                this.instancedMesh.scale.setScalar(1.0);
                this.instancedMesh.position.y = 0;
            }
        }
        
        // dist = width / (2 * tan(fov/2) * aspect)
        // tan(30) = 0.577
        let dist = targetWidth / (1.154 * aspect);
        
        // Clamp minimum distance
        dist = Math.max(250, dist);
        
        // Limit max distance on mobile so planet doesn't disappear
        if (isMobile) {
            dist = Math.min(dist, 600); // Relaxed limit (was 500) to fit larger text
        }
        
        this.cameraBasePos.z = dist;
    }

    _onPointerMove(e) {
        this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    }

    _onPointerDown(e) {
        this.raycaster.setFromCamera(this.pointer, this.camera);
        
        // Raycast against a plane at z=0 (where text is roughly)
        // or just project a ray and find closest voxels
        
        const ray = this.raycaster.ray;
        const impactPoint = new THREE.Vector3();
        
        // Approximate impact on Z=0 plane
        // origin + t * dir = point. point.z = 0 => origin.z + t * dir.z = 0 => t = -origin.z / dir.z
        const t = -ray.origin.z / ray.direction.z;
        if (t > 0) {
            ray.at(t, impactPoint);
            this._explode(impactPoint);
        }
    }

    _explode(point) {
        const radius = 60; // Blast radius
        const force = 0.8; // Reduced force
        
        this.voxels.forEach(voxel => {
            const dist = voxel.pos.distanceTo(point);
            if (dist < radius) {
                voxel.isFloating = false;
                
                // Direction away from impact
                const dir = new THREE.Vector3().subVectors(voxel.pos, point).normalize();
                // Add some randomness
                dir.x += (Math.random() - 0.5) * 0.5;
                dir.y += (Math.random() - 0.5) * 0.5;
                dir.z += (Math.random() - 0.5) * 2.0; // More depth scatter
                
                const intensity = (1 - dist / radius) * force;
                voxel.velocity.addScaledVector(dir, intensity * 8); // Gentle push
                
                voxel.rotationVel.set(
                    Math.random() - 0.5,
                    Math.random() - 0.5,
                    Math.random() - 0.5
                ).multiplyScalar(0.2);
            }
        });
    }

    _createPlanetImpact(position) {
        // Deprecated - replaced by _damagePlanet logic, but keeping for compatibility if called elsewhere
        const geo = new THREE.SphereGeometry(12, 8, 8); // Larger flash for larger planet
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffaa00,
            transparent: true,
            opacity: 1.0
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(position);
        
        this.scene.add(mesh);
        this.planetImpacts.push({ mesh, life: 0.6 });
    }

    _animate(time) {
        this._raf = requestAnimationFrame(this._animate.bind(this));
        
        const dt = Math.min((time - this._lastTime) / 1000, 0.1);
        this._lastTime = time;

        // Animate stars
        if (this.starSystem) {
            this.starSystem.rotation.y += 0.05 * dt;
        }

        // Animate Planet & Attackers
        if (this.planet) {
            this.planet.rotation.y += 0.02 * dt;
            
            this.planetAttackers.forEach((attacker, idx) => {
                // Advanced Attack Pattern (Jet-like movement with banking)
                
                // Update internal time/angle
                attacker.angle += attacker.speed * 0.4 * dt; // Faster orbit
                
                // Dynamic Radius: Fly closer then pull away (Attack runs)
                const baseDist = attacker.dist + 50; // Increased safety margin
                // Vary distance using sine wave (fly in, fly out)
                const r = baseDist + Math.sin(attacker.angle * 2.0) * 80;
                
                // Vertical Oscillation (Sine wave) for 3D feel
                const h = Math.sin(attacker.angle * 3.0 + idx) * 120;
                
                // Calculate target position
                // Full orbit around planet
                const x = this.planet.position.x + Math.cos(attacker.angle) * r;
                const z = this.planet.position.z + Math.sin(attacker.angle) * r; // Full circular orbit
                const y = this.planet.position.y + h;
                
                const targetPos = new THREE.Vector3(x, y, z);
                
                // Smooth movement (Inertia)
                attacker.mesh.position.lerp(targetPos, dt * 3.0);
                
                // Smart Banking Logic (Roll into turn)
                // Calculate look-ahead position
                const nextAngle = attacker.angle + 0.2;
                const nextR = baseDist + Math.sin(nextAngle * 2.0) * 80;
                const nextH = Math.sin(nextAngle * 3.0 + idx) * 120;
                
                const nextX = this.planet.position.x + Math.cos(nextAngle) * nextR;
                const nextZ = this.planet.position.z + Math.sin(nextAngle) * nextR;
                const nextY = this.planet.position.y + nextH;
                const lookAtPos = new THREE.Vector3(nextX, nextY, nextZ);
                
                // Calculate banking up vector
                // "Up" leans towards the planet (center of turn)
                const toPlanet = new THREE.Vector3().subVectors(this.planet.position, attacker.mesh.position).normalize();
                const globalUp = new THREE.Vector3(0, 1, 0);
                const bankUp = new THREE.Vector3().lerpVectors(globalUp, toPlanet, 0.8); // Strong bank
                
                const m = new THREE.Matrix4();
                m.lookAt(attacker.mesh.position, lookAtPos, bankUp);
                const targetQuat = new THREE.Quaternion().setFromRotationMatrix(m);
                attacker.mesh.quaternion.slerp(targetQuat, dt * 5.0);
                
                // Fire Logic
                attacker.nextFire -= dt;
                if (attacker.nextFire <= 0) {
                    // Only fire if facing roughly towards planet (during attack run)
                    const dirToPlanet = toPlanet.clone();
                    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(attacker.mesh.quaternion);
                    
                    // If we are somewhat facing the planet
                    if (forward.dot(dirToPlanet) > 0.3) {
                        attacker.nextFire = 0.3 + Math.random() * 0.8; // Faster rate of fire during run
                        
                        // Pick a random spot on the planet
                        // Use sphere surface point to ensure we hit voxels
                        const targetLocal = new THREE.Vector3(
                            Math.random()-0.5,
                            Math.random()-0.5,
                            Math.random()-0.5
                        ).normalize().multiplyScalar(320); // Planet radius updated to 320
                        
                        // We need to add this to the planet position (which is the center)
                        // Note: this.planet is now an Object3D at the center, so applyMatrix4 works if we treat it as local offset
                        // Actually, simpler to just add vectors since rotation is likely 0 or handled by parent
                        const targetWorld = targetLocal.clone().add(this.planet.position);
                        
                        // Green laser beams
                        this._spawnLaser(attacker.mesh.position.clone(), targetWorld, 0x00ff00);
                        
                        // Impact visual
                        const dist = attacker.mesh.position.distanceTo(targetWorld);
                        const flightTime = dist / 600;
                        
                        setTimeout(() => {
                            // this._createPlanetImpact(targetWorld); // OLD
                            this._damagePlanet(targetWorld); // NEW
                        }, flightTime * 1000);
                    } else {
                        // Wait for next alignment
                        attacker.nextFire = 0.2;
                    }
                }
            });
            
            // Animate Impacts
            for (let i = this.planetImpacts.length - 1; i >= 0; i--) {
                const impact = this.planetImpacts[i];
                impact.life -= dt * 2.0;
                if (impact.life <= 0) {
                    this.scene.remove(impact.mesh);
                    impact.mesh.geometry.dispose();
                    impact.mesh.material.dispose();
                    this.planetImpacts.splice(i, 1);
                } else {
                    impact.mesh.scale.setScalar(2.0 - impact.life); // Expand
                    impact.mesh.material.opacity = impact.life;
                }
            }
        }
        
        // Animate Asteroids
        this.asteroids.forEach(asteroid => {
            asteroid.group.rotation.x += asteroid.rotVel.x * dt;
            asteroid.group.rotation.y += asteroid.rotVel.y * dt;
            asteroid.group.rotation.z += asteroid.rotVel.z * dt;
        });
        
        // Animate Loose Voxels
        for (let i = this.looseVoxels.length - 1; i >= 0; i--) {
            const v = this.looseVoxels[i];
            v.life -= dt;
            if (v.life <= 0) {
                this.scene.remove(v.mesh);
                v.mesh.geometry.dispose();
                v.mesh.material.dispose();
                this.looseVoxels.splice(i, 1);
            } else {
                v.mesh.position.addScaledVector(v.velocity, dt);
                v.mesh.rotation.x += v.rotVel.x * dt;
                v.mesh.rotation.y += v.rotVel.y * dt;
                v.mesh.scale.setScalar(Math.min(1, v.life)); // Shrink out
            }
        }
        
        // Laser Collisions
        for (let i = this.lasers.length - 1; i >= 0; i--) {
            const laser = this.lasers[i];
            
            // Check against Asteroids
            let hit = false;
            for (let j = this.asteroids.length - 1; j >= 0; j--) {
                const asteroid = this.asteroids[j];
                if (laser.mesh.position.distanceTo(asteroid.group.position) < asteroid.radius) {
                    this._explodeAsteroid(asteroid, laser.mesh.position, laser.velocity.clone().normalize());
                    hit = true;
                    break;
                }
            }
            
            if (hit) {
                this.scene.remove(laser.mesh);
                this.lasers.splice(i, 1);
            }
        }

        // Camera drift (Cinematic feel)
        // Lerp towards base + drift
        const driftX = Math.sin(time * 0.2) * 10;
        const driftY = Math.cos(time * 0.3) * 5;
        
        const targetX = this.cameraBasePos.x + driftX;
        const targetY = this.cameraBasePos.y + driftY;
        const targetZ = this.cameraBasePos.z;
        
        this.camera.position.x += (targetX - this.camera.position.x) * 0.05;
        this.camera.position.y += (targetY - this.camera.position.y) * 0.05;
        this.camera.position.z += (targetZ - this.camera.position.z) * 0.05;
        
        this.camera.lookAt(0, 0, -50);

            // Animate Dogfight
        this.ships.forEach((ship, idx) => {
            ship.t += ship.speed * dt;
            
            // Current position on curve
            const pos = this._getDogfightPosition(ship.t);
            const nextPos = this._getDogfightPosition(ship.t + 0.1); // Look ahead
            
            // Vector calculation for banking
            const tangent = new THREE.Vector3().subVectors(nextPos, pos).normalize();
            
            // Dynamic Up Vector for 3D loops
            // Prevents flipping when going vertical
            // We approximate "up" by the curvature normal + global up blend
            const nextNextPos = this._getDogfightPosition(ship.t + 0.2);
            const nextTangent = new THREE.Vector3().subVectors(nextNextPos, nextPos).normalize();
            const curvature = new THREE.Vector3().subVectors(nextTangent, tangent).normalize();
            
            // If curvature is strong, use it as "up" (centripetal), else Global Up
            let refUp = new THREE.Vector3(0, 1, 0);
            if (curvature.lengthSq() > 0.001) {
                // For a loop, "up" is towards the center of the turn (curvature)
                // But banking means we roll *against* the turn?
                // Actually for aircraft: Lift vector (Local Up) points into the turn.
                // So we want the ship's Local Y to align with Curvature.
                refUp.lerp(curvature, 0.8);
            }
            
            // Orientation matrix
            const m = new THREE.Matrix4();
            m.lookAt(pos, nextPos, refUp);
            const targetQuat = new THREE.Quaternion().setFromRotationMatrix(m);
            
            // Smoothly interpolate rotation
            ship.mesh.quaternion.slerp(targetQuat, 0.1);
            
            // Smoothly interpolate position (reduce jitter)
            ship.mesh.position.lerp(pos, 0.15);
            
            // Combat Logic (simplified for jet feel - shoot forward)
            if (ship.type === 'chaser') {
                 if (Math.random() < 0.08) { 
                     // Shoot straight ahead with slight spread
                     const muzzle = ship.mesh.position.clone().addScaledVector(tangent, 5);
                     const aim = muzzle.clone().addScaledVector(tangent, 100);
                     aim.x += (Math.random()-0.5)*5;
                     aim.y += (Math.random()-0.5)*5;
                     
                     // Occasionally target asteroids
                     const asteroid = this.asteroids.length > 0 && Math.random() < 0.3 ? this.asteroids[Math.floor(Math.random() * this.asteroids.length)] : null;
                     if (asteroid) {
                        const dir = new THREE.Vector3().subVectors(asteroid.group.position, ship.mesh.position).normalize();
                        if (dir.dot(tangent) > 0.8) { // Only if somewhat in front
                            this._spawnLaser(muzzle, asteroid.group.position, 0xff0000);
                        } else {
                            this._spawnLaser(muzzle, aim, 0xff0000); 
                        }
                     } else {
                        this._spawnLaser(muzzle, aim, 0xff0000); 
                     }
                 }
            } else {
                 // Return fire (rear gunner style)
                 if (Math.random() < 0.05) {
                     const chaser = this.ships.find(s => s.type === 'chaser');
                     if (chaser) {
                         this._spawnLaser(ship.mesh.position.clone(), chaser.mesh.position.clone(), 0x00aaff); 
                     }
                 }
            }
        });
        
        // Animate Lasers
        for (let i = this.lasers.length - 1; i >= 0; i--) {
            const laser = this.lasers[i];
            laser.life -= dt;
            if (laser.life <= 0) {
                this.scene.remove(laser.mesh);
                laser.mesh.geometry.dispose();
                laser.mesh.material.dispose();
                this.lasers.splice(i, 1);
            } else {
                laser.mesh.position.addScaledVector(laser.velocity, dt);
            }
        }
        
        // Animate voxels
        if (this.instancedMesh) {
            this.voxels.forEach(voxel => {
                if (voxel.isFloating) {
                    // Gentle float
                    const floatY = Math.sin(time * 0.002 + voxel.pos.x * 0.05) * 2.0;
                    this.dummy.position.copy(voxel.initialPos);
                    this.dummy.position.y += floatY;
                    
                    // Look slightly at mouse? No, keep it simple.
                    this.dummy.rotation.set(0, 0, 0);
                } else {
                    // Physics
                    voxel.pos.add(voxel.velocity);
                    
                    // Friction/Damping
                    voxel.velocity.multiplyScalar(0.95);
                    
                    // Rotation
                    voxel.rotation.x += voxel.rotationVel.x;
                    voxel.rotation.y += voxel.rotationVel.y;
                    voxel.rotation.z += voxel.rotationVel.z;
                    
                    this.dummy.position.copy(voxel.pos);
                    this.dummy.rotation.set(voxel.rotation.x, voxel.rotation.y, voxel.rotation.z);
                    
                    // Return to home if slow? No, just drift.
                }
                
                this.dummy.updateMatrix();
                this.instancedMesh.setMatrixAt(voxel.index, this.dummy.matrix);
            });
            this.instancedMesh.instanceMatrix.needsUpdate = true;
        }

        this.composer.render();
    }
}
