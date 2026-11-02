import type { FC, SVGProps } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { backend } from "@/lib/backend";
import { onWindowFocus } from "@/lib/windowFocus";
import {
    AntigravityIcon,
    AquaIcon,
    CLionIcon,
    CursorIcon,
    DataGripIcon,
    DataSpellIcon,
    GoLandIcon,
    IntelliJIdeaIcon,
    KiroIcon,
    PhpStormIcon,
    PyCharmIcon,
    RiderIcon,
    RubyMineIcon,
    RustRoverIcon,
    TraeIcon,
    VisualStudioCode,
    VisualStudioCodeInsiders,
    VSCodium,
    WebStormIcon,
    Zed
} from "./icons";

/**
 * "Open in …": the code editors `list_editors` finds installed (ids from
 * `src-tauri/src/open_in.rs`), the one picked last, and opening a folder in it.
 */

export type EditorInfo = {
    label: string;
    /** Its mark; none draws a generic one. */
    icon?: FC<SVGProps<SVGSVGElement>>;
};

export const EDITORS: Record<string, EditorInfo> = {
    vscode: { label: "VS Code", icon: VisualStudioCode },
    cursor: { label: "Cursor", icon: CursorIcon },
    zed: { label: "Zed", icon: Zed },
    windsurf: { label: "Windsurf" },
    "vscode-insiders": { label: "VS Code Insiders", icon: VisualStudioCodeInsiders },
    vscodium: { label: "VSCodium", icon: VSCodium },
    trae: { label: "Trae", icon: TraeIcon },
    kiro: { label: "Kiro", icon: KiroIcon },
    antigravity: { label: "Antigravity", icon: AntigravityIcon },
    idea: { label: "IntelliJ IDEA", icon: IntelliJIdeaIcon },
    webstorm: { label: "WebStorm", icon: WebStormIcon },
    rustrover: { label: "RustRover", icon: RustRoverIcon },
    pycharm: { label: "PyCharm", icon: PyCharmIcon },
    goland: { label: "GoLand", icon: GoLandIcon },
    clion: { label: "CLion", icon: CLionIcon },
    rider: { label: "Rider", icon: RiderIcon },
    phpstorm: { label: "PhpStorm", icon: PhpStormIcon },
    rubymine: { label: "RubyMine", icon: RubyMineIcon },
    datagrip: { label: "DataGrip", icon: DataGripIcon },
    dataspell: { label: "DataSpell", icon: DataSpellIcon },
    aqua: { label: "Aqua", icon: AquaIcon }
};

type EditorsState = {
    /** Installed editors, in menu order; null until first read. */
    installed: string[] | null;
    /** The one "Open in" opens, picked from the menu (persisted). */
    preferred: string | null;
    setPreferred: (id: string) => void;
};

export const useEditorsStore = create<EditorsState>()(
    persist(
        (set) => ({
            installed: null,
            preferred: null,
            setPreferred: (preferred) => set({ preferred })
        }),
        { name: "hive.editors", partialize: (s) => ({ preferred: s.preferred }) }
    )
);

let lastRead = 0;
/** At most this often; an editor installed meanwhile shows up on the next read. */
const FRESH_MS = 60_000;

/** Re-reads the installed editors, unless read within the last minute (`force` skips that). */
export async function refreshEditors(force = false) {
    if (!force && Date.now() - lastRead < FRESH_MS) return;
    lastRead = Date.now();
    try {
        const installed = await backend<string[]>("list_editors", undefined, () => [
            "vscode",
            "cursor",
            "zed"
        ]);
        useEditorsStore.setState({ installed: installed.filter((id) => id in EDITORS) });
    } catch {
        lastRead = 0;
    }
}

onWindowFocus(() => void refreshEditors());

/** The editor "Open in" uses: the picked one while it's installed, else the first installed. */
export function useEditor(): { installed: string[] | null; current: string | null } {
    const installed = useEditorsStore((s) => s.installed);
    const preferred = useEditorsStore((s) => s.preferred);
    const current =
        installed && preferred && installed.includes(preferred) ? preferred : (installed?.[0] ?? null);
    return { installed, current };
}

export function openInEditor(id: string, path: string) {
    return backend<void>("open_in_editor", { id, path });
}
