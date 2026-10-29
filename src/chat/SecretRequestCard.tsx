import { useEffect, useRef, useState } from "react";
import {
    EyeIcon,
    EyeSlashIcon,
    LockSimpleIcon
} from "@phosphor-icons/react";
import type { SecretRequest } from "@/proto";
import { cn } from "@/lib/cn";
import { Markdown } from "@/transcript/Markdown";
import { Button, Input } from "@/ui";

/**
 * An agent asking for a secret (Hive's `request_secret` tool), in place of
 * the composer. What's typed goes straight to the app, which saves it to a
 * private file for the agent's commands; it never enters the chat. The card
 * goes when the session drops the request: answered, or the turn ended.
 */
export function SecretRequestCard({
    request,
    onAnswer,
    className
}: {
    request: SecretRequest;
    /** `null` declines. */
    onAnswer: (value: string | null) => Promise<void>;
    className?: string;
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
                setError(e instanceof Error ? e.message : String(e));
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
                "flex w-full flex-col gap-3 rounded-[22px] border border-dark-600 bg-dark-850 p-4",
                "transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0",
                className
            )}
        >
            <div className="flex min-w-0 flex-col gap-1">
                <div className="truncate text-sm font-medium text-dark-50">{request.label}</div>
                <Markdown className="text-sm leading-6 text-dark-200">{request.reason}</Markdown>
            </div>

            <div className="flex min-w-0 items-center gap-2">
                <Input
                    ref={inputRef}
                    // Not `password`: that offers to save it as a login.
                    type="text"
                    value={value}
                    disabled={!!sending}
                    invalid={!!error}
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
                    wrapperClassName="flex-1"
                    className={cn(!shown && value && "[-webkit-text-security:disc]")}
                    rightIcon={
                        <button
                            type="button"
                            onClick={() => setShown(!shown)}
                            aria-label={shown ? "Hide" : "Show"}
                            className="flex items-center text-dark-200 transition-colors hover:text-dark-50"
                        >
                            {shown ? (
                                <EyeSlashIcon className="size-3.5" />
                            ) : (
                                <EyeIcon className="size-3.5" />
                            )}
                        </button>
                    }
                />
                <Button
                    type="submit"
                    variant="primary"
                    disabled={!canSave}
                    loading={sending === "save"}
                >
                    Save securely
                </Button>
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="flex min-w-0 items-center gap-2">
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-dark-250">
                    <LockSimpleIcon weight="fill" className="size-3 shrink-0" />
                    <span className="truncate">
                        Kept out of chat, in a private file this agent's commands can read for 24 hours
                    </span>
                </p>
                <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto shrink-0"
                    disabled={!!sending}
                    loading={sending === "decline"}
                    onClick={() => send(null)}
                >
                    Decline
                </Button>
            </div>
        </form>
    );
}
