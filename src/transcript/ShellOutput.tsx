import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { plainText, useTaskOutput } from "./shellTask";

/** How often an open shell's output is read again. */
const OUTPUT_POLL_MS = 1500;

/**
 * The end of a background shell's output, read again while shown; pinned to
 * the bottom unless scrolled up. Older lines fade out at the top.
 */
export function ShellOutput({
    chatId,
    taskId,
    className,
    style
}: {
    chatId: string;
    taskId: string;
    className?: string;
    style?: CSSProperties;
}) {
    const { output, error } = useTaskOutput(chatId, taskId, OUTPUT_POLL_MS);
    const [copied, copy] = useCopy();
    const ref = useRef<HTMLPreElement>(null);
    const pinned = useRef(true);

    const text = useMemo(() => (output ? plainText(output.output) : ""), [output]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (el && pinned.current) el.scrollTop = el.scrollHeight;
    }, [text]);

    return (
        <div className={cn("flex flex-col gap-1", className)} style={style}>
            <div className="overflow-hidden rounded-md border border-dark-700 bg-dark-900">
                <div className="relative">
                    <pre
                        ref={ref}
                        onScroll={(e) => {
                            const el = e.currentTarget;
                            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
                        }}
                        className={cn(
                            "max-h-48 overflow-auto px-2.5 py-2",
                            "font-mono text-[10.5px] leading-[1.5] break-all whitespace-pre-wrap",
                            text ? "text-dark-100" : "text-dark-250"
                        )}
                    >
                        {text || (error ? "" : output ? "No output yet." : "Reading…")}
                    </pre>
                    <span className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-dark-900 to-transparent" />
                </div>
                <div className="flex items-center gap-2 border-t border-dark-700 py-0.5 pr-0.5 pl-2.5 text-[10.5px] text-dark-250">
                    <span className="min-w-0 flex-1 truncate">
                        {output?.truncated
                            ? `Last 8 KB of ${Math.round(output.totalBytes / 1024).toLocaleString("en-US")} KB`
                            : ""}
                    </span>
                    <button
                        type="button"
                        disabled={!text}
                        onClick={() => copy(text)}
                        className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-dark-200 outline-none transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700 disabled:pointer-events-none disabled:opacity-50"
                    >
                        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
            </div>
            {error && <span className="text-[11px] text-danger">{error}</span>}
        </div>
    );
}
