import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
import { folderName } from "./paths";

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
        request = (
            isTauri
                ? invoke<string | null>("folder_icon", { path })
                : Promise.resolve(null)
        )
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
 * Monogram tones, as in zeron: a stable pick per folder, explicit colours
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
    const [icon, setIcon] = useState(() => settled.get(path) ?? null);
    const [broken, setBroken] = useState(false);

    useEffect(() => {
        let live = true;
        setBroken(false);
        setIcon(settled.get(path) ?? null);
        void loadIcon(path).then((next) => {
            if (live) setIcon(next);
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
                onError={() => setBroken(true)}
                className={cn("size-4 shrink-0 rounded-[3px] object-contain", className)}
            />
        );
    }

    const tone = toneOf(path);
    const letter = (folderName(path).trim()[0] ?? "?").toUpperCase();
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
