/**
 * A short two-note chime, synthesized so there's no asset to ship. The
 * webview may keep audio suspended until the user has interacted with the
 * page, so `unlockAudio` resumes it on the first key or click.
 */
let context: AudioContext | null = null;

function audio() {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume().catch(() => {});
    return context;
}

/** Call once at the root; returns the cleanup. */
export function unlockAudio(): () => void {
    const unlock = () => {
        audio();
        remove();
    };
    const remove = () => {
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return remove;
}

/** Rising for a question, falling for a finished turn. */
const CHIMES = {
    input: [880, 1318.5],
    finished: [1318.5, 987.8]
} as const;

export function playChime(kind: keyof typeof CHIMES) {
    let ctx: AudioContext;
    try {
        ctx = audio();
    } catch {
        return;
    }
    const start = ctx.currentTime + 0.01;
    for (const [i, frequency] of CHIMES[kind].entries()) {
        const delay = i * 0.11;
        const at = start + delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.5);
    }
}
