import { spaceships } from './spaceshipData.js';
import { Game } from './game.js';
import { HudController } from './ui/hudController.js';
import { ShipSelectHangar } from './ui/shipSelectHangar.js';

const selectionScreen = document.getElementById('selection-screen');
const hud = document.getElementById('hud');

let game = null;
const hudController = new HudController(document);
let hangar = null;

function startGame(selectedShip) {
    selectionScreen.classList.add('hidden');
    hud.classList.remove('hidden');

    if (hangar) {
        hangar.dispose();
        hangar = null;
    }
    
    // Initialize the 3D Game
    game = new Game(selectedShip, { hud: hudController });
    game.init();
}

const canvas = document.getElementById('game-canvas');
hangar = new ShipSelectHangar({
    canvas,
    ships: spaceships,
    onSelect: (ship) => startGame(ship)
});
hangar.init();
