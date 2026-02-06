export class SoundManager {
    constructor() {
        this.context = null;
        this.masterGain = null;
        this.initialized = false;
        
        // Settings
        this.volume = 0.3; // Global volume
    }

    init() {
        if (this.initialized) return;

        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.context = new AudioContext();
            this.masterGain = this.context.createGain();
            this.masterGain.gain.value = this.volume;
            this.masterGain.connect(this.context.destination);
            this.initialized = true;
            console.log("Audio System Initialized");
        } catch (e) {
            console.error("Web Audio API not supported", e);
        }
    }

    // Helper to create an oscillator with envelope
    playTone(freq, type, duration, vol = 1, slideTo = null) {
        if (!this.initialized) this.init();
        if (!this.context) return;

        const osc = this.context.createOscillator();
        const gain = this.context.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.context.currentTime);
        if (slideTo) {
            osc.frequency.exponentialRampToValueAtTime(slideTo, this.context.currentTime + duration);
        }

        gain.gain.setValueAtTime(vol, this.context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + duration);

        osc.connect(gain);
        gain.connect(this.masterGain);

        osc.start();
        osc.stop(this.context.currentTime + duration);
    }

    // Helper to generate noise
    createNoiseBuffer() {
        if (!this.context) return null;
        const bufferSize = this.context.sampleRate * 2; // 2 seconds
        const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        return buffer;
    }

    playShoot() {
        // Soft sci-fi laser
        // Start high, drop quickly
        this.playTone(800, 'sine', 0.15, 0.3, 200);
        // Add a little square wave for texture, lower volume
        this.playTone(600, 'triangle', 0.1, 0.1, 100);
    }

    playHit() {
        // Short metallic ping
        this.playTone(1200, 'sine', 0.05, 0.2);
    }

    playExplosion(size = 1) {
        if (!this.initialized) this.init();
        if (!this.context) return;

        // Clamp size to prevent ear-bleeding volume for massive objects
        const safeSize = Math.min(size, 3);
        const isMassive = size > 5; // Planet check
        
        const duration = 0.5 + safeSize * 0.3;
        
        // 1. Pink Noise for the "crunch" (Softer than white noise)
        const noiseBuffer = this.createNoiseBuffer();
        const noise = this.context.createBufferSource();
        noise.buffer = noiseBuffer;
        
        const noiseFilter = this.context.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        // Lower frequency for massive objects -> deeper sound
        const startFreq = isMassive ? 400 : 800;
        noiseFilter.frequency.setValueAtTime(startFreq, this.context.currentTime);
        noiseFilter.frequency.exponentialRampToValueAtTime(50, this.context.currentTime + duration);

        const noiseGain = this.context.createGain();
        // Cap volume at 0.6 max
        const volume = Math.min(0.3 * safeSize, 0.6);
        noiseGain.gain.setValueAtTime(volume, this.context.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + duration);

        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.masterGain);
        
        noise.start();
        noise.stop(this.context.currentTime + duration);

        // 2. Low frequency boom (Sine wave drop)
        // Deeper and longer for planets
        const boomFreq = isMassive ? 80 : 150;
        const boomDur = isMassive ? duration * 1.5 : duration;
        this.playTone(boomFreq, 'sine', boomDur, volume, 20);
    }

    playCollect() {
        // Pleasant chime (Major chord arpeggio)
        const now = this.context.currentTime;
        
        [523.25, 659.25, 783.99].forEach((freq, i) => { // C5, E5, G5
            const osc = this.context.createOscillator();
            const gain = this.context.createGain();
            
            osc.type = 'sine';
            osc.frequency.value = freq;
            
            gain.gain.setValueAtTime(0, now + i * 0.05);
            gain.gain.linearRampToValueAtTime(0.2, now + i * 0.05 + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.05 + 0.3);
            
            osc.connect(gain);
            gain.connect(this.masterGain);
            
            osc.start(now + i * 0.05);
            osc.stop(now + i * 0.05 + 0.3);
        });
    }

    playError() {
        // Low buzzer
        this.playTone(150, 'sawtooth', 0.2, 0.2, 100);
    }

    playDeposit() {
        // Magical refill sound (reverse sweep ish)
        if (!this.initialized) this.init();
        if (!this.context) return;
        
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(200, this.context.currentTime);
        osc.frequency.exponentialRampToValueAtTime(800, this.context.currentTime + 0.5);
        
        gain.gain.setValueAtTime(0, this.context.currentTime);
        gain.gain.linearRampToValueAtTime(0.3, this.context.currentTime + 0.1);
        gain.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.5);
        
        osc.connect(gain);
        gain.connect(this.masterGain);
        
        osc.start();
        osc.stop(this.context.currentTime + 0.5);
    }
}
