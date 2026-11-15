import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { chatsApi } from "@/features/chats/api";
import { baseName } from "@/lib/paths";

/**
 * Each folder's icon (`folder_icon`: its favicon or app icon as a data URL,
 * or null), looked up once per launch. Settled values are kept apart so a
 * known icon draws on the first render instead of flashing the monogram.
 */
const pending = new Map<string, Promise<string | null>>();
const settled = new Map<string, string | null>();

function loadIcon(path: string): Promise<string | null> {
    let request = pending.get(path);
    if (!request) {
        request = chatsApi
            .folderIcon(path)
            .catch(() => null)
            .then((icon) => {
                settled.set(path, icon);
                return icon;
            });
        pending.set(path, request);
    }
    return request;
}

/**
 * Monogram tones: a stable pick per folder, explicit colours
 * that don't follow the theme.
 */
const TONES = [
    "#94a3b8", // slate
    "#93c5fd", // blue
    "#c4b5fd", // violet
    "#fda4af", // rose
    "#fcd34d", // amber
    "#6ee7b7", // emerald
    "#5eead4", // teal
    "#fdba74" // orange
];

/** FNV-1a, so a folder keeps its colour across launches. */
function toneOf(seed: string): string {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
    }
    return TONES[hash % TONES.length]!;
}

/**
 * A project folder's icon: its own favicon when it has one, else its first
 * letter on a tile tinted by the folder's path. `selected` deepens the tint.
 */
export function ProjectIcon({
    path,
    selected = false,
    className
}: {
    path: string;
    selected?: boolean;
    className?: string;
}) {
    // Per path: another folder starts over with what's known of it.
    const [state, setState] = useState(() => ({ path, icon: settled.get(path) ?? null, broken: false }));
    if (state.path !== path) setState({ path, icon: settled.get(path) ?? null, broken: false });
    const { icon, broken } = state;
    const setBroken = () => setState((s) => ({ ...s, broken: true }));

    useEffect(() => {
        let live = true;
        void loadIcon(path).then((next) => {
            if (live) setState((s) => (s.path === path ? { ...s, icon: next } : s));
        });
        return () => {
            live = false;
        };
    }, [path]);

    if (icon && !broken) {
        return (
            <img
                src={icon}
                alt=""
                draggable={false}
                onError={setBroken}
                className={cn("size-4 shrink-0 rounded-[3px] object-contain", className)}
            />
        );
    }

    const tone = toneOf(path);
    const letter = (baseName(path).trim()[0] ?? "?").toUpperCase();
    return (
        <span
            aria-hidden="true"
            style={{
                // Hex alpha: 8% (24% selected) behind, 85% for the letter.
                backgroundColor: `${tone}${selected ? "3d" : "14"}`,
                color: selected ? tone : `${tone}d9`
            }}
            className={cn(
                "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px]",
                "font-mono text-[9px] leading-none font-medium",
                className
            )}
        >
            {letter}
        </span>
    );
}
