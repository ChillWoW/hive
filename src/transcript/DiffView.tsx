import { FileBody } from "@/diff/DiffFiles";
import type { FileDiff } from "@/diff/patch";
import { useDiffPrefs } from "@/diff/store";
import { cn } from "@/lib/cn";

/** A file change in the diff tab's rows (unified, its wrap setting). Scrolls past 20rem. */
export function DiffView({ file, className }: { file: FileDiff; className?: string }) {
    const wrap = useDiffPrefs((s) => s.wrap);
    return (
        <div className={cn("max-h-80 overflow-y-auto rounded-md bg-dark-850 py-1", className)}>
            <FileBody file={file} split={false} wrap={wrap} />
        </div>
    );
}
