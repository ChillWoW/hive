import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import type { Message } from "@/proto";
import { useCopy } from "@/lib/clipboard";
import { formatElapsed, useNow } from "@/lib/time";
import { DotMatrixSpinner, Tooltip } from "@/ui";
import { pendingInput } from "../fold";
import { TurnParts } from "./Parts";

const formatDuration = (ms: number) => formatElapsed(ms, { round: true });

/** The line under a turn in progress: a spinner, a shimmering "Working" (or "Waiting for you" while it asks something), and for how long. */
function WorkingStatus({ since, waiting }: { since: number; waiting: boolean }) {
    const now = useNow();
    return (
        <div className="flex items-center gap-2 text-sm">
            <DotMatrixSpinner label={waiting ? "Waiting" : "Working"} className="text-text/80" />
            <span className="shimmer font-[450] text-muted">{waiting ? "Waiting for you" : "Working"}</span>
            <span className="text-muted/85 tabular-nums">{formatDuration(now - since)}</span>
        </div>
    );
}

function CopyButton({ text }: { text: string }) {
    const [copied, copy] = useCopy();
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label="Copy"
                        onClick={() => copy(text)}
                        className="inline-flex size-6 items-center justify-center rounded-sm text-muted/85 transition-colors hover:bg-hover hover:text-text"
                    >
                        {copied ? (
                            <CheckIcon className="size-3.5" weight="bold" />
                        ) : (
                            <CopyIcon className="size-3.5" />
                        )}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{copied ? "Copied" : "Copy"}</Tooltip.Content>
        </Tooltip>
    );
}

/**
 * What the agent did and said in one turn, in order: markdown, and thoughts
 * and tool calls grouped (consecutive file edits on one line), and errors.
 * While the turn runs a status line sits under it; once done, a copy button
 * and how long it took.
 */
export function AssistantMessage({ message }: { message: Message }) {
    const streaming = message.status === "streaming";
    const parts = message.parts;
    // What copy takes: the text after the last bit of work, i.e. the answer.
    const lastWork = parts.findLastIndex((p) => p.kind !== "text");
    const answer = parts
        .slice(lastWork + 1)
        .flatMap((p) => (p.kind === "text" && p.text.trim() ? [p.text] : []))
        .join("\n\n");

    return (
        <div className="flex flex-col gap-3">
            <TurnParts parts={parts} streaming={streaming} />
            {streaming && <WorkingStatus since={message.createdAt} waiting={!!pendingInput(parts)} />}
            {!streaming && (
                <div className="-mt-1 flex h-6 items-center gap-2 text-xs text-muted/85">
                    {answer && <CopyButton text={answer} />}
                    {message.durationMs !== undefined && (
                        <span className="tabular-nums">{formatDuration(message.durationMs)}</span>
                    )}
                    {message.status === "aborted" && <span>Stopped</span>}
                </div>
            )}
        </div>
    );
}
