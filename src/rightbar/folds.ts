import { useCallback, useState } from "react";
import type { FileDiff } from "@/diff/patch";

export type Folds = ReturnType<typeof useFolds>;

/** Which of `files` are folded (the diff and commit tabs); each starts folded. */
export function useFolds(files: FileDiff[]) {
    const [folds, setFolds] = useState<Record<string, boolean>>({});
    const isFolded = (file: FileDiff) => folds[file.path] ?? true;
    const allFolded = files.length > 0 && files.every(isFolded);
    const toggle = useCallback(
        (path: string, folded: boolean) => setFolds((s) => ({ ...s, [path]: !folded })),
        []
    );
    const toggleAll = () => setFolds(Object.fromEntries(files.map((f) => [f.path, !allFolded])));
    return { isFolded, allFolded, toggle, toggleAll, empty: files.length === 0 };
}
