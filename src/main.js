import { spaceships } from './spaceshipData.js';
import { Game } from './game.js';
import { HudController } from './ui/hudController.js';
import { ShipSelectHangar } from './ui/shipSelectHangar.js';
import { EntryScene } from './ui/entryScene.js';

const SETTINGS_KEY = 'wreckspace.settings.v1';
const DEFAULT_SETTINGS = {
    invertPitch: false,
    quality: 'auto',
    uiScale: 1,
    contrast: 'default',
    colorVision: 'default',
    mobileHudSide: 'default'
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


function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function applyVisualSettings() {
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(clamp(Number(appSettings.uiScale) || 1, 0.85, 1.25)));
    root.dataset.contrast = appSettings.contrast === 'high' ? 'high' : 'default';
    root.dataset.colorVision = appSettings.colorVision || 'default';
    root.dataset.mobileHudSide = appSettings.mobileHudSide || 'default';
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
applyVisualSettings();

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
    applyVisualSettings();
    if (game && typeof game.setInvertPitch === 'function') {
        game.setInvertPitch(!!appSettings.invertPitch);
    }
    if (appSettings.quality && appSettings.quality !== 'auto') {
        const q = String(appSettings.quality);
        const url = new URL(window.location.href);
        if (url.searchParams.get('quality') !== q) {
            url.searchParams.set('quality', q);
            history.replaceState(null, '', url.toString());
        }
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

const goToHangar = (opts = {}) => {
    entryScreen.classList.add('hidden');
    selectionScreen.classList.remove('hidden');
    const mode = opts.mode ?? 'main';
    const modeInput = document.querySelector(`input[name="world-mode"][value="${mode}"]`);
    if (modeInput) modeInput.checked = true;

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
    startBtn.addEventListener('click', () => goToHangar({ mode: 'main' }));
}
if (hangarBtn) {
    hangarBtn.addEventListener('click', () => goToHangar({ mode: 'testArea' }));
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
                    <select id="setting-quality">
                        <option value="auto" ${appSettings.quality === 'auto' ? 'selected' : ''}>AUTO</option>
                        <option value="low" ${appSettings.quality === 'low' ? 'selected' : ''}>LOW</option>
                        <option value="medium" ${appSettings.quality === 'medium' ? 'selected' : ''}>MEDIUM</option>
                        <option value="high" ${appSettings.quality === 'high' ? 'selected' : ''}>HIGH</option>
                    </select>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label">UI Scale</div>
                <div class="setting-control">
                    <input id="setting-ui-scale" type="range" min="85" max="125" value="${Math.round((appSettings.uiScale ?? 1) * 100)}"> 
                    <span id="setting-ui-scale-value">${Math.round((appSettings.uiScale ?? 1) * 100)}%</span>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label">Contrast</div>
                <div class="setting-control">
                    <select id="setting-contrast">
                        <option value="default" ${appSettings.contrast === 'default' ? 'selected' : ''}>DEFAULT</option>
                        <option value="high" ${appSettings.contrast === 'high' ? 'selected' : ''}>HIGH</option>
                    </select>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label">Color Vision Preset</div>
                <div class="setting-control">
                    <select id="setting-color-vision">
                        <option value="default" ${appSettings.colorVision === 'default' ? 'selected' : ''}>DEFAULT</option>
                        <option value="deuteranopia" ${appSettings.colorVision === 'deuteranopia' ? 'selected' : ''}>DEUTERANOPIA</option>
                        <option value="protanopia" ${appSettings.colorVision === 'protanopia' ? 'selected' : ''}>PROTANOPIA</option>
                    </select>
                </div>
            </div>
            <div class="setting-row">
                <div class="setting-label">Mobile HUD Side</div>
                <div class="setting-control">
                    <select id="setting-mobile-hud-side">
                        <option value="default" ${appSettings.mobileHudSide === 'default' ? 'selected' : ''}>DEFAULT</option>
                        <option value="left" ${appSettings.mobileHudSide === 'left' ? 'selected' : ''}>LEFT-HANDED</option>
                        <option value="right" ${appSettings.mobileHudSide === 'right' ? 'selected' : ''}>RIGHT-HANDED</option>
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
            <div class="setting-help">Graphics quality changes apply immediately to future sessions. Use URL <code>?quality=low|medium|high</code> to force profile.</div>
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

        const qualityEl = document.getElementById('setting-quality');
        qualityEl?.addEventListener('change', () => saveSettings({ quality: qualityEl.value }));

        const uiScaleEl = document.getElementById('setting-ui-scale');
        const uiScaleValueEl = document.getElementById('setting-ui-scale-value');
        uiScaleEl?.addEventListener('input', () => {
            const nextScale = clamp(Number(uiScaleEl.value) / 100, 0.85, 1.25);
            if (uiScaleValueEl) uiScaleValueEl.textContent = `${Math.round(nextScale * 100)}%`;
            saveSettings({ uiScale: nextScale });
        });

        const contrastEl = document.getElementById('setting-contrast');
        contrastEl?.addEventListener('change', () => saveSettings({ contrast: contrastEl.value }));

        const cvEl = document.getElementById('setting-color-vision');
        cvEl?.addEventListener('change', () => saveSettings({ colorVision: cvEl.value }));

        const mobileHudEl = document.getElementById('setting-mobile-hud-side');
        mobileHudEl?.addEventListener('change', () => saveSettings({ mobileHudSide: mobileHudEl.value }));
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
    const enemyAiPresetRaw = new URL(window.location.href).searchParams.get('enemyAi') ?? 'balanced';
    const enemyAiPreset = /^(aggressive|balanced|cowardly)$/.test(enemyAiPresetRaw) ? enemyAiPresetRaw : 'balanced';
    
    // Initialize the 3D Game
    game = new Game(selectedShip, {
        hud: hudController,
        mode,
        invertPitch: !!appSettings.invertPitch,
        enemyAiPreset
    });
    game.init();
    hudController.setHintPreset(mode === 'testArea' ? 'tutorial' : 'desktop');
}
