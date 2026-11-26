import { useEffect, type ReactNode } from "react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import { useSettingsStore } from "@/features/settings/store";
import { DIFF_THEMES, lineDiffType } from "./diffs";

const POOL_OPTIONS = { workerFactory: () => new DiffsWorker() };
const HIGHLIGHTER_OPTIONS = {
    theme: DIFF_THEMES,
    langs: ["typescript", "tsx", "javascript", "jsx", "rust", "json", "css", "html", "markdown", "toml", "python", "shellscript"]
};

/** The pool highlights inline changes itself: keep it on the setting. */
function SyncInlineChanges() {
    const pool = useWorkerPool();
    const inline = useSettingsStore((s) => s.settings.diffs.inlineChanges);
    useEffect(() => {
        void pool?.setRenderOptions({ lineDiffType: lineDiffType(inline) });
    }, [pool, inline]);
    return null;
}

/**
 * The diff views' highlighting, off the main thread: a worker pool with its
 * themes and the usual languages loaded at start-up. Mounted in `main.tsx`.
 */
export function DiffsPool({ children }: { children: ReactNode }) {
    return (
        <WorkerPoolContextProvider poolOptions={POOL_OPTIONS} highlighterOptions={HIGHLIGHTER_OPTIONS}>
            <SyncInlineChanges />
            {children}
        </WorkerPoolContextProvider>
    );
}
