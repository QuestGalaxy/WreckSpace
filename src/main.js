import { spaceships } from './spaceshipData.js';
import { Game } from './game.js';
import { HudController } from './ui/hudController.js';
import { ShipSelectHangar } from './ui/shipSelectHangar.js';
import { EntryScene } from './ui/entryScene.js';

const SETTINGS_KEY = 'wreckspace.settings.v1';
const DEFAULT_SETTINGS = {
    invertPitch: false
};

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_SETTINGS,
            ...(parsed && typeof parsed === 'object' ? parsed : {})
        };
    } catch (_) {
        return { ...DEFAULT_SETTINGS };
    }
}

const entryScreen = document.getElementById('entry-screen');
const startBtn = document.getElementById('start-btn');
const hangarBtn = document.getElementById('hangar-btn');
const settingsBtn = document.getElementById('settings-btn');
const creditsBtn = document.getElementById('credits-btn');
const selectionScreen = document.getElementById('selection-screen');

// Modal Elements
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalClose = document.getElementById('modal-close');

// Modal Logic
function openModal(title, contentHTML) {
    modalTitle.innerText = title;
    modalBody.innerHTML = contentHTML;
    modalOverlay.classList.remove('hidden');
}

function closeModal() {
    modalOverlay.classList.add('hidden');
}

if (modalClose) {
    modalClose.addEventListener('click', closeModal);
}
// Close on click outside
modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
});

const hud = document.getElementById('hud');
const canvas = document.getElementById('game-canvas');

let game = null;
const hudController = new HudController(document);
let hangar = null;
let entryScene = null;
let appSettings = loadSettings();

function saveSettings(nextPartial) {
    appSettings = {
        ...appSettings,
        ...(nextPartial && typeof nextPartial === 'object' ? nextPartial : {})
    };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
    } catch (_) {
        // ignore storage issues (private mode, quota, etc.)
    }
    if (game && typeof game.setInvertPitch === 'function') {
        game.setInvertPitch(!!appSettings.invertPitch);
    }
}

// Initialize Entry Scene immediately
if (entryScreen && !entryScreen.classList.contains('hidden')) {
    entryScene = new EntryScene({
        canvas,
        onStart: () => {}
    });
    entryScene.init();
}

const goToHangar = () => {
    entryScreen.classList.add('hidden');
    selectionScreen.classList.remove('hidden');

    // Dispose Entry Scene
    if (entryScene) {
        entryScene.dispose();
        entryScene = null;
    }

    // Initialize Hangar
    if (!hangar) {
        hangar = new ShipSelectHangar({
            canvas,
            ships: spaceships,
            onSelect: (ship) => startGame(ship)
        });
        hangar.init();
    }
};

if (startBtn) {
    startBtn.addEventListener('click', goToHangar);
}
if (hangarBtn) {
    hangarBtn.addEventListener('click', goToHangar);
}
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        const html = `
            <div class="setting-row">
                <div class="setting-label">Music Volume</div>
                <div class="setting-control"><input type="range" min="0" max="100" value="80"></div>
            </div>
            <div class="setting-row">
                <div class="setting-label">SFX Volume</div>
                <div class="setting-control"><input type="range" min="0" max="100" value="100"></div>
            </div>
            <div class="setting-row">
                <div class="setting-label">Mouse Sensitivity</div>
                <div class="setting-control"><input type="range" min="1" max="10" value="5"></div>
            </div>
            <div class="setting-row">
                <div class="setting-label">Graphics Quality</div>
                <div class="setting-control">
                    <select>
                        <option>LOW</option>
                        <option selected>MEDIUM</option>
                        <option>HIGH</option>
                        <option>ULTRA</option>
                    </select>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label">Invert Pitch (Flight)</div>
                <div class="setting-control">
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
                        <input id="setting-invert-pitch" type="checkbox" ${appSettings.invertPitch ? 'checked' : ''}>
                        <span>${appSettings.invertPitch ? 'Enabled' : 'Disabled'}</span>
                    </label>
                </div>
            </div>
        `;
        openModal("SYSTEM CONFIG", html);

        const invertPitchEl = document.getElementById('setting-invert-pitch');
        if (invertPitchEl) {
            const stateText = invertPitchEl.nextElementSibling;
            invertPitchEl.addEventListener('change', () => {
                const next = !!invertPitchEl.checked;
                saveSettings({ invertPitch: next });
                if (stateText) stateText.textContent = next ? 'Enabled' : 'Disabled';
            });
        }
    });
}
if (creditsBtn) {
    creditsBtn.addEventListener('click', () => {
        const html = `
            <div class="credits-role">Lead Developer & Designer</div>
            <div class="credits-name">Kazım Akgül</div>
            
            <div class="credits-role">Engine Architecture</div>
            <div class="credits-name">WreckSpace Core Team</div>
            
            <div class="credits-tech">
                <span class="tech-tag">THREE.JS</span>
                <span class="tech-tag">WEBGL</span>
                <span class="tech-tag">JAVASCRIPT</span>
                <span class="tech-tag">HTML5</span>
            </div>
        `;
        openModal("CREDITS", html);
    });
}

function startGame(selectedShip) {
    selectionScreen.classList.add('hidden');
    hud.classList.remove('hidden');

    if (hangar) {
        hangar.dispose();
        hangar = null;
    }

    const mode =
        document.querySelector('input[name="world-mode"]:checked')?.value ??
        'main';
    
    // Initialize the 3D Game
    game = new Game(selectedShip, {
        hud: hudController,
        mode,
        invertPitch: !!appSettings.invertPitch
    });
    game.init();
}
