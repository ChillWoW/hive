import { fakeMac } from "@/lib/platform";

/**
 * Where `trafficLightPosition` in `tauri.macos.conf.json` puts the window
 * buttons, drawn for a dev build posing as macOS (see `platform.ts`). tao
 * insets the close button by `x` and grows the titlebar container to the
 * button's height plus `y`; the buttons keep their offset inside it, which on
 * macOS 26+ (14pt buttons, ~23pt apart) puts their centres `y - 2` down: the
 * 36px top bar's middle at y=20.
 */
const POSITION = { x: 14, y: 20 };
const SIZE = 14;
const SPACING = 23;
const COLORS = ["#ff5f57", "#febc2e", "#28c840"];

export function FakeTrafficLights() {
    if (!fakeMac) return null;
    return (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50">
            {COLORS.map((color, i) => (
                <span
                    key={color}
                    style={{
                        left: POSITION.x + i * SPACING,
                        top: POSITION.y - 2 - SIZE / 2,
                        width: SIZE,
                        height: SIZE,
                        background: color
                    }}
                    className="absolute rounded-full ring-[0.5px] ring-black/20"
                />
            ))}
        </div>
    );
}
