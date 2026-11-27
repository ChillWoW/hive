import type { NotificationSound } from "@/features/settings/types";

/** The sounds a setting can pick, in menu order. */
export const SOUNDS: { value: NotificationSound; label: string }[] = [
    { value: "none", label: "None" },
    { value: "chime", label: "Chime" },
    { value: "ping", label: "Ping" },
    { value: "pop", label: "Pop" },
    { value: "knock", label: "Knock" },
    { value: "buzz", label: "Buzz" }
];

type Note = {
    type: OscillatorType;
    freq: number;
    /** Glides there over the note. */
    endFreq?: number;
    /** Seconds after the sound starts. */
    at: number;
    duration: number;
    /** 0–1, before the volume. */
    peak: number;
};

// Synthesized, so nothing is bundled or decoded.
const RECIPES: Record<Exclude<NotificationSound, "none">, Note[]> = {
    chime: [
        { type: "sine", freq: 659.25, at: 0, duration: 0.5, peak: 0.5 },
        { type: "sine", freq: 987.77, at: 0.11, duration: 0.7, peak: 0.45 }
    ],
    ping: [
        { type: "sine", freq: 1174.66, at: 0, duration: 0.9, peak: 0.5 },
        { type: "sine", freq: 2349.32, at: 0, duration: 0.35, peak: 0.12 }
    ],
    pop: [{ type: "sine", freq: 520, endFreq: 180, at: 0, duration: 0.09, peak: 0.7 }],
    knock: [
        { type: "triangle", freq: 190, endFreq: 110, at: 0, duration: 0.09, peak: 0.9 },
        { type: "triangle", freq: 190, endFreq: 110, at: 0.15, duration: 0.11, peak: 0.9 }
    ],
    buzz: [
        { type: "triangle", freq: 311.13, at: 0, duration: 0.16, peak: 0.6 },
        { type: "triangle", freq: 233.08, at: 0.17, duration: 0.3, peak: 0.6 }
    ]
};

let context: AudioContext | null = null;

function audio(): AudioContext | null {
    try {
        context ??= new AudioContext();
        if (context.state === "suspended") void context.resume().catch(() => {});
        return context;
    } catch {
        return null;
    }
}

/**
 * Webviews keep audio suspended until the page is used: call from a pointer
 * or key press, so a sound played later from the background is heard.
 */
export function primeSounds() {
    audio();
}

/** Plays `sound` at `volume` percent. */
export function playSound(sound: NotificationSound, volume: number) {
    if (sound === "none" || volume <= 0) return;
    const ctx = audio();
    if (!ctx) return;
    const level = Math.min(volume, 100) / 100;
    const now = ctx.currentTime + 0.02;
    for (const note of RECIPES[sound]) {
        const start = now + note.at;
        const end = start + note.duration;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = note.type;
        osc.frequency.setValueAtTime(note.freq, start);
        if (note.endFreq) osc.frequency.exponentialRampToValueAtTime(note.endFreq, end);
        // A fast attack and a tail to (near) silence: no clicks at either end.
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(note.peak * level, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(end + 0.02);
    }
}
