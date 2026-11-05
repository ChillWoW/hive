import { useEffect, useRef, useState } from "react";
import {
    EyeIcon,
    EyeSlashIcon,
    LockSimpleIcon
} from "@phosphor-icons/react";
import type { SecretRequest } from "@/proto";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { Markdown } from "@/transcript/Markdown";
import { Button, Tooltip } from "@/ui";
import { chipClassName } from "@/ui/chip";

/**
 * An agent asking for a secret (Hive's `request_secret` tool), in place of
 * the composer. What's typed goes straight to the app, which saves it to a
 * private file for the agent's commands; it never enters the chat. The card
 * goes when the session drops the request: answered, or the turn ended.
 */
export function SecretRequestCard({
    request,
    onAnswer
}: {
    request: SecretRequest;
    /** `null` declines. */
    onAnswer: (value: string | null) => Promise<void>;
}) {
    const [value, setValue] = useState("");
    const [shown, setShown] = useState(false);
    const [sending, setSending] = useState<"save" | "decline">();
    const [error, setError] = useState<string>();
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const send = (answer: string | null) => {
        if (sending) return;
        setSending(answer === null ? "decline" : "save");
        setError(undefined);
        onAnswer(answer).then(
            // Kept disabled until the card goes; nothing more to hold on to.
            () => setValue(""),
            (e: unknown) => {
                setSending(undefined);
                setError(errorMessage(e));
            }
        );
    };

    const canSave = value.trim().length > 0 && !sending;

    return (
        <form
            autoComplete="off"
            onSubmit={(event) => {
                event.preventDefault();
                if (canSave) send(value);
            }}
            className={cn(
                // The composer's box, which this card stands in for.
                "flex w-full flex-col overflow-hidden rounded-[22px] border border-dark-700 bg-dark-850",
                "transition-[opacity,translate,border-color] duration-200 ease-out focus-within:border-dark-600",
                "starting:translate-y-1 starting:opacity-0"
            )}
        >
            <div className="flex min-w-0 flex-col gap-0.5 border-b border-dark-700 px-4 pt-3.5 pb-3">
                <div className="truncate text-sm font-medium text-dark-50">{request.label}</div>
                <Markdown className="text-sm leading-6 text-dark-200">{request.reason}</Markdown>
            </div>

            <div className="flex min-w-0 items-center gap-2.5 px-4 pt-3.5 pb-1.5">
                <input
                    ref={inputRef}
                    // Not `password`: that offers to save it as a login.
                    type="text"
                    value={value}
                    disabled={!!sending}
                    aria-invalid={!!error}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder={request.placeholder ?? "Paste the secret"}
                    aria-label={request.label}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    className={cn(
                        "min-w-0 flex-1 bg-transparent text-sm text-dark-50 outline-none placeholder:text-dark-300",
                        "disabled:opacity-60",
                        !shown && value && "[-webkit-text-security:disc]"
                    )}
                />
                <button
                    type="button"
                    onClick={() => setShown(!shown)}
                    aria-label={shown ? "Hide" : "Show"}
                    className="flex shrink-0 items-center text-dark-250 transition-colors hover:text-dark-50"
                >
                    {shown ? (
                        <EyeSlashIcon className="size-4" />
                    ) : (
                        <EyeIcon className="size-4" />
                    )}
                </button>
            </div>

            {error && <p className="px-4 pt-1 text-xs text-danger">{error}</p>}

            <div className="flex min-w-0 items-center gap-1.5 px-2 pt-1.5 pb-2">
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <span className={cn(chipClassName, "cursor-default text-dark-250")}>
                                <LockSimpleIcon weight="fill" className="size-3 shrink-0" />
                                <span className="truncate">Kept out of chat · 24h</span>
                            </span>
                        }
                    />
                    <Tooltip.Content side="top">
                        Saved to a private file this agent's commands can read for 24 hours
                    </Tooltip.Content>
                </Tooltip>
                <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-7 shrink-0 rounded-[9px] text-dark-200"
                    disabled={!!sending}
                    loading={sending === "decline"}
                    onClick={() => send(null)}
                >
                    Decline
                </Button>
                <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    className="h-7 shrink-0 rounded-[9px]"
                    disabled={!canSave}
                    loading={sending === "save"}
                >
                    Save securely
                </Button>
            </div>
        </form>
    );
}
