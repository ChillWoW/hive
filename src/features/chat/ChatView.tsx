import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The column the transcript and the composer share: centred, at most
 * `max-w-3xl`, inside the pane's `px-6`. Beside open panels it narrows with
 * the main column, which the layout keeps at least `MAIN_MIN_WIDTH` wide.
 */
export const laneClassName = "mx-auto w-full max-w-3xl";

/**
 * The main pane: the active chat's transcript with the composer under it,
 * or, before a chat's first prompt, the composer centred under a heading.
 * Only the new-chat view exists until chats do.
 */
export function ChatView() {
    return (
        <div className="relative flex h-full w-full flex-col items-center justify-center pb-16">
            <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-text">
                What should we build?
            </h1>
            <div className="w-full">
                <Bottom />
            </div>
        </div>
    );
}

/** Under the transcript (or the heading): the composer, to come. */
function Bottom({ className, children }: { className?: string; children?: ReactNode }) {
    return (
        <div className="shrink-0 px-6 pb-3">
            <div className={cn(laneClassName, className)}>{children}</div>
        </div>
    );
}

/** The transcript's scroller: messages down the lane, its scrollbar kept clear of it. */
export function TranscriptScroller({ children }: { children?: ReactNode }) {
    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]">
                <div className={cn(laneClassName, "flex flex-col gap-5 py-6")}>{children}</div>
            </div>
        </div>
    );
}
