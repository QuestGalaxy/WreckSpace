import { spaceships } from './spaceshipData.js';
import { Game } from './game.js';
import { HudController } from './ui/hudController.js';

const selectionScreen = document.getElementById('selection-screen');
const spaceshipList = document.getElementById('spaceship-list');
const hud = document.getElementById('hud');

let game = null;
const hudController = new HudController(document);

function initSelectionScreen() {
    spaceships.forEach(ship => {
        const card = document.createElement('div');
        card.className = 'spaceship-card';
        
        // Determine Ship Class based on ID for flavor text
        let shipClass = "Standard Class";
        if (ship.id === 'scout') shipClass = "Reconnaissance Class";
        else if (ship.id === 'interceptor') shipClass = "Assault Class";
        else if (ship.id === 'hauler') shipClass = "Industrial Class";

        // Calculate Percentages (Max values estimated from data)
        const powerPct = (ship.weaponPower / 25) * 100;
        const speedPct = (ship.speed / 1.5) * 100;
        const storagePct = (ship.storage / 120) * 100;

        card.innerHTML = `
            <h3>${ship.name}</h3>
            <span class="ship-class">${shipClass}</span>
            
            <div class="stat-row power">
                <div class="stat-label"><span>Firepower</span> <span>${ship.weaponPower}</span></div>
                <div class="stat-track">
                    <div class="stat-value-bar" data-width="${powerPct}%" style="width: 0%"></div>
                </div>
            </div>

            <div class="stat-row speed">
                <div class="stat-label"><span>Speed</span> <span>${ship.speed}</span></div>
                <div class="stat-track">
                    <div class="stat-value-bar" data-width="${speedPct}%" style="width: 0%"></div>
                </div>
            </div>

            <div class="stat-row storage">
                <div class="stat-label"><span>Cargo Bay</span> <span>${ship.storage}</span></div>
                <div class="stat-track">
                    <div class="stat-value-bar" data-width="${storagePct}%" style="width: 0%"></div>
                </div>
            </div>

            <p class="card-desc">${ship.description}</p>
            <button class="select-btn">Initialize</button>
        `;
        
        card.onclick = () => startGame(ship);
        spaceshipList.appendChild(card);
        
        // Animate bars after a short delay
        setTimeout(() => {
            card.querySelectorAll('.stat-value-bar').forEach(bar => {
                bar.style.width = bar.getAttribute('data-width');
            });
        }, 100 + spaceships.indexOf(ship) * 100); // Staggered animation
    });
}

function startGame(selectedShip) {
    selectionScreen.classList.add('hidden');
    hud.classList.remove('hidden');
    
    // Initialize the 3D Game
    game = new Game(selectedShip, { hud: hudController });
    game.init();
}

initSelectionScreen();
