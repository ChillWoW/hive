import { ArrowClockwiseIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import type { TranscriptMessage } from "@/chats";
import { cn } from "@/lib/cn";

/**
 * What the user sent, as a bubble on the right. A prompt the backend hasn't
 * saved yet shows dimmed; one that failed says why, with Retry and Discard.
 */
export function UserMessage({
    message,
    onRetry,
    onDiscard
}: {
    message: TranscriptMessage;
    onRetry?: () => void;
    onDiscard?: () => void;
}) {
    const text = message.parts
        .flatMap((p) => (p.kind === "text" ? [p.text] : []))
        .join("\n\n");
    const delivery = message.delivery;

    return (
        <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
            <div
                className={cn(
                    "rounded-2xl rounded-br-md bg-dark-800 px-3 py-1.5 text-sm leading-6 whitespace-pre-wrap break-words text-dark-50",
                    delivery?.state === "sending" && "opacity-70",
                    delivery?.state === "failed" && "ring-1 ring-danger/40"
                )}
            >
                {text}
            </div>
            {delivery?.state === "failed" && (
                <div className="flex items-center gap-1 text-xs text-danger">
                    <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
                    <span className="min-w-0 truncate" title={delivery.error}>
                        {delivery.error}
                    </span>
                    {onRetry && (
                        <button
                            type="button"
                            onClick={onRetry}
                            className="ml-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-dark-200 hover:bg-dark-700 hover:text-dark-50"
                        >
                            <ArrowClockwiseIcon className="size-3" />
                            Retry
                        </button>
                    )}
                    {onDiscard && (
                        <button
                            type="button"
                            onClick={onDiscard}
                            className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-dark-200 hover:bg-dark-700 hover:text-dark-50"
                        >
                            <XIcon className="size-3" />
                            Discard
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
