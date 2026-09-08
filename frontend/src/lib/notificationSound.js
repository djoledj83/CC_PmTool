// Chat notification sounds — synthesised with WebAudio (no binary assets).
// Mute + chosen sound id are persisted in localStorage per browser.

const STORAGE_MUTED = 'chat:muted';
const STORAGE_SOUND = 'chat:sound';
const DEFAULT_SOUND_ID = 'soft-tap';

let audioCtx = null;

function getAudioContext() {
    if (typeof window === 'undefined') return null;
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
        audioCtx = new Ctor();
    } catch {
        audioCtx = null;
    }
    return audioCtx;
}

export function primeAudio() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }
}

let primedFromGesture = false;
export function installAudioGestureUnlock() {
    if (typeof window === 'undefined') return () => {};
    if (primedFromGesture) return () => {};

    const handler = () => {
        primedFromGesture = true;
        primeAudio();
        for (const evt of EVENTS) {
            window.removeEventListener(evt, handler, true);
        }
    };
    const EVENTS = ['pointerdown', 'keydown', 'touchstart', 'click'];
    for (const evt of EVENTS) {
        window.addEventListener(evt, handler, { capture: true, passive: true });
    }
    return () => {
        for (const evt of EVENTS) {
            window.removeEventListener(evt, handler, true);
        }
    };
}

export function isChatMuted() {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(STORAGE_MUTED) === '1';
    } catch {
        return false;
    }
}

export function setChatMuted(muted) {
    if (typeof window === 'undefined') return;
    try {
        if (muted) window.localStorage.setItem(STORAGE_MUTED, '1');
        else window.localStorage.removeItem(STORAGE_MUTED);
    } catch {
        // non-fatal
    }
}

/** @typedef {{ id: string, label: string, master: number, notes: Array<{ freq: number, t?: number, type?: OscillatorType, attack?: number, decay?: number, peak?: number }> }} ChatSoundPreset */

/** @type {ChatSoundPreset[]} */
export const CHAT_SOUND_PRESETS = [
    {
        id: 'soft-tap',
        label: 'Soft tap',
        master: 0.04,
        notes: [{ freq: 440, attack: 0.04, decay: 0.22, peak: 0.55 }],
    },
    {
        id: 'gentle-chime',
        label: 'Gentle chime',
        master: 0.05,
        notes: [
            { freq: 659.25, t: 0, attack: 0.03, decay: 0.35, peak: 0.5 },
            { freq: 987.77, t: 0.08, attack: 0.03, decay: 0.4, peak: 0.45 },
        ],
    },
    {
        id: 'droplet',
        label: 'Droplet',
        master: 0.045,
        notes: [{ freq: 880, type: 'sine', attack: 0.01, decay: 0.14, peak: 0.4 }],
    },
    {
        id: 'whisper',
        label: 'Whisper',
        master: 0.03,
        notes: [{ freq: 1200, attack: 0.02, decay: 0.1, peak: 0.35 }],
    },
    {
        id: 'marimba',
        label: 'Marimba',
        master: 0.05,
        notes: [
            { freq: 523.25, t: 0, attack: 0.008, decay: 0.12, peak: 0.6 },
            { freq: 392, t: 0.07, attack: 0.008, decay: 0.18, peak: 0.5 },
        ],
    },
    {
        id: 'glass',
        label: 'Glass',
        master: 0.04,
        notes: [
            { freq: 1046.5, type: 'triangle', attack: 0.005, decay: 0.2, peak: 0.35 },
        ],
    },
    {
        id: 'bell',
        label: 'Bell',
        master: 0.045,
        notes: [
            { freq: 784, type: 'triangle', attack: 0.02, decay: 0.45, peak: 0.5 },
        ],
    },
    {
        id: 'wood',
        label: 'Wood knock',
        master: 0.055,
        notes: [{ freq: 220, attack: 0.003, decay: 0.08, peak: 0.7 }],
    },
    {
        id: 'pulse',
        label: 'Pulse',
        master: 0.04,
        notes: [
            { freq: 330, attack: 0.015, decay: 0.1, peak: 0.55 },
            { freq: 330, t: 0.14, attack: 0.015, decay: 0.1, peak: 0.4 },
        ],
    },
    {
        id: 'horizon',
        label: 'Horizon',
        master: 0.035,
        notes: [{ freq: 293.66, attack: 0.06, decay: 0.5, peak: 0.45 }],
    },
];

const PRESET_BY_ID = new Map(
    CHAT_SOUND_PRESETS.map((p) => [p.id, p]),
);

export function getChatSoundId() {
    if (typeof window === 'undefined') return DEFAULT_SOUND_ID;
    try {
        const raw = window.localStorage.getItem(STORAGE_SOUND);
        if (raw && PRESET_BY_ID.has(raw)) return raw;
    } catch {
        // ignore
    }
    return DEFAULT_SOUND_ID;
}

export function setChatSoundId(soundId) {
    const id = PRESET_BY_ID.has(soundId) ? soundId : DEFAULT_SOUND_ID;
    if (typeof window !== 'undefined') {
        try {
            window.localStorage.setItem(STORAGE_SOUND, id);
        } catch {
            // ignore
        }
    }
    return id;
}

function playPreset(preset, { ignoreMute = false } = {}) {
    if (!ignoreMute && isChatMuted()) return;
    const ctx = getAudioContext();
    if (!ctx || !preset) return;
    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }
    try {
        const now = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.value = preset.master;
        master.connect(ctx.destination);

        for (const note of preset.notes) {
            const start = now + (note.t || 0);
            const attack = note.attack ?? 0.025;
            const decay = note.decay ?? 0.25;
            const peak = note.peak ?? 0.55;

            const osc = ctx.createOscillator();
            osc.type = note.type || 'sine';
            osc.frequency.value = note.freq;

            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, start);
            g.gain.exponentialRampToValueAtTime(peak, start + attack);
            g.gain.exponentialRampToValueAtTime(0.0001, start + decay);

            osc.connect(g).connect(master);
            osc.start(start);
            osc.stop(start + decay + 0.05);
        }
    } catch {
        // skip on unsupported browsers
    }
}

export function previewChatSound(soundId) {
    const preset = PRESET_BY_ID.get(soundId) || PRESET_BY_ID.get(DEFAULT_SOUND_ID);
    playPreset(preset, { ignoreMute: true });
}

export function playMessageSound(soundId) {
    const id = soundId || getChatSoundId();
    const preset = PRESET_BY_ID.get(id) || PRESET_BY_ID.get(DEFAULT_SOUND_ID);
    playPreset(preset);
}
