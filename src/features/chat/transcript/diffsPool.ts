import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from "@pierre/diffs/react";

/** The same Shiki themes as the transcript's code blocks. */
export const DIFF_THEMES = { dark: "github-dark", light: "github-light" } as const;

/**
 * The diff views' highlighting, off the main thread: a worker pool, its
 * themes and the usual languages loaded at start-up. Mounted in `main.tsx`.
 */
export const DIFFS_POOL: { poolOptions: WorkerPoolOptions; highlighterOptions: WorkerInitializationRenderOptions } = {
    poolOptions: { workerFactory: () => new DiffsWorker() },
    highlighterOptions: {
        theme: DIFF_THEMES,
        langs: ["typescript", "tsx", "javascript", "jsx", "rust", "json", "css", "html", "markdown", "toml", "python", "shellscript"]
    }
};
