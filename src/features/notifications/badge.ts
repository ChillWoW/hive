import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, platform } from "@/lib/platform";

const SIZE = 32;

/** The count as a red dot, for Windows' taskbar overlay (it has no badge of its own). */
function overlay(count: number): Uint8Array | null {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#e5484d";
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    const text = count > 9 ? "9+" : String(count);
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${text.length > 1 ? 18 : 22}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, SIZE / 2, SIZE / 2 + 1.5);
    return new Uint8Array(ctx.getImageData(0, 0, SIZE, SIZE).data.buffer);
}

let shown = 0;
// One at a time, in order: a clear can't land before the count it clears.
let queue: Promise<unknown> = Promise.resolve();

/** Shows `count` on the app's taskbar or dock icon; 0 takes it off. */
export function setBadge(count: number) {
    if (!isTauri || count === shown) return;
    shown = count;
    queue = queue
        .then(() => apply(count))
        .catch((error: unknown) => console.warn("[notifications] badge", error));
}

async function apply(count: number) {
    const window = getCurrentWindow();
    if (platform !== "windows") return window.setBadgeCount(count || undefined);
    const pixels = count > 0 ? overlay(count) : null;
    if (!pixels) return window.setOverlayIcon(undefined);
    const image = await Image.new(pixels, SIZE, SIZE);
    try {
        await window.setOverlayIcon(image);
    } finally {
        await image.close();
    }
}
