import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { isTauri, platform } from "./platform";

let home: Promise<string | null> | null = null;

/** The user's home folder, asked once; null under plain `bun run dev`. */
export function getHomeDir(): Promise<string | null> {
    home ??= isTauri
        ? homeDir().then((dir) => dir.replace(/[/\\]+$/, ""), () => null)
        : Promise.resolve(null);
    return home;
}

/** The home folder, for render: null until known. */
export function useHomeDir(): string | null {
    const [dir, setDir] = useState<string | null>(null);
    useEffect(() => {
        void getHomeDir().then(setDir);
    }, []);
    return dir;
}

/**
 * `path` with the home folder shown as `~` (`C:\Users\me\.hive` →
 * `~\.hive`); unchanged outside it. Case-insensitive on Windows.
 */
export function tildify(path: string, homeDir: string | null): string {
    if (!homeDir) return path;
    const fold = (s: string) => (platform === "windows" ? s.toLowerCase() : s);
    if (fold(path) === fold(homeDir)) return "~";
    const head = path.slice(0, homeDir.length);
    const sep = path[homeDir.length];
    if (fold(head) === fold(homeDir) && (sep === "/" || sep === "\\")) {
        return `~${path.slice(homeDir.length)}`;
    }
    return path;
}

/** `tildify` undone: a leading `~` back to the home folder. */
export function untildify(path: string, homeDir: string | null): string {
    if (!homeDir || !/^~([/\\]|$)/.test(path)) return path;
    return homeDir + path.slice(1);
}
