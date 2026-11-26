import { fakeMac } from "@/lib/platform";

/**
 * Where `trafficLightPosition` in `tauri.macos.conf.json` puts the window
 * buttons, drawn for a dev build posing as macOS (see `platform.ts`). tao
 * insets the close button's 14x16 frame by `x`, spaces the buttons 20pt apart
 * and grows the titlebar container to the frame's height plus `y`; the buttons
 * keep their offset inside it, which puts their centres about `y + 2` down.
 */
const POSITION = { x: 14, y: 20 };
const COLORS = ["#ff5f57", "#febc2e", "#28c840"];

export function FakeTrafficLights() {
    if (!fakeMac) return null;
    return (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50">
            {COLORS.map((color, i) => (
                <span
                    key={color}
                    style={{
                        left: POSITION.x + 1 + i * 20,
                        top: POSITION.y + 2 - 6,
                        background: color
                    }}
                    className="absolute size-3 rounded-full ring-[0.5px] ring-black/20"
                />
            ))}
        </div>
    );
}
