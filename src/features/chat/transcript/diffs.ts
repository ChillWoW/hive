import type { LineDiffTypes } from "@pierre/diffs";
import type { InlineChanges } from "@/features/settings/types";

/** The same Shiki themes as the transcript's code blocks; the pool and the views must agree. */
export const DIFF_THEMES = { dark: "github-dark", light: "github-light" } as const;

/** The inline-changes setting as Pierre's line diff type. */
export function lineDiffType(inline: InlineChanges): LineDiffTypes {
    return inline === "word" ? "word-alt" : inline === "char" ? "char" : "none";
}
