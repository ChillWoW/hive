import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, platform } from "@/lib/platform";

const SIZE = 32;

/** RGBA pixels of a red dot with the count, for Windows' overlay icon. */
function drawBadge(count: number): Uint8Array | null {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const color =
        getComputedStyle(document.documentElement)
            .getPropertyValue("--color-danger")
            .trim() || "#ff616e";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.fill();

    const label = count > 9 ? "9+" : String(count);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${label.length > 1 ? 17 : 22}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, SIZE / 2, SIZE / 2 + 1);
    return new Uint8Array(ctx.getImageData(0, 0, SIZE, SIZE).data.buffer);
}

async function apply(count: number) {
    const win = getCurrentWindow();
    // Windows has no badge count; an overlay icon on the taskbar button is
    // its equivalent.
    if (platform !== "windows") {
        await win.setBadgeCount(count > 0 ? count : undefined);
        return;
    }
    const pixels = count > 0 ? drawBadge(count) : null;
    if (!pixels) {
        await win.setOverlayIcon(undefined);
        return;
    }
    const image = await Image.new(pixels, SIZE, SIZE);
    try {
        await win.setOverlayIcon(image);
    } finally {
        void image.close().catch(() => {});
    }
}

let shown = 0;
let wanted = 0;
let running: Promise<void> | null = null;

/** Shows `count` on the app's taskbar / dock icon; 0 clears it. */
export function setBadge(count: number) {
    if (!isTauri) return;
    wanted = count;
    // One update at a time; the last count asked for wins.
    running ??= (async () => {
        while (shown !== wanted) {
            const next = wanted;
            try {
                await apply(next);
            } catch (error) {
                console.warn("[notifications] badge failed", error);
            }
            shown = next;
        }
        running = null;
    })();
}
