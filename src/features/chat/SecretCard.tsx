import { useState } from "react";
import { EyeIcon, EyeSlashIcon, KeyIcon } from "@phosphor-icons/react";
import type { SecretRequest } from "@/proto";
import { chatsApi } from "@/features/chats/api";
import { Button, toast } from "@/ui";
import { cardClassName } from "./cards";

/**
 * An agent asking for a secret (`request_secret`): what it's for, a masked
 * field, Save or Decline. The value goes to a private file the agent reads;
 * it never enters the chat or its history.
 */
export function SecretCard({ request }: { request: SecretRequest }) {
    const [value, setValue] = useState("");
    const [visible, setVisible] = useState(false);
    const [busy, setBusy] = useState(false);
    const answer = async (secret: string | null) => {
        setBusy(true);
        try {
            await chatsApi.answerSecret(request.id, secret);
        } catch (error) {
            toast.error({ title: "Couldn't answer", description: error instanceof Error ? error.message : String(error) });
            setBusy(false);
        }
    };
    return (
        <div className={cardClassName}>
            <div className="flex items-center gap-2 text-xs text-muted">
                <KeyIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate font-medium">{request.label}</span>
            </div>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (value) void answer(value);
                }}
                className="flex flex-col gap-3"
            >
                <p className="text-sm leading-6 whitespace-pre-wrap text-text">{request.reason}</p>
                <div className="flex items-center gap-1.5">
                    <input
                        type={visible ? "text" : "password"}
                        value={value}
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={request.placeholder ?? "Paste it here"}
                        aria-label={request.label}
                        onChange={(event) => setValue(event.target.value)}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 font-mono text-[13px] text-text outline-none placeholder:text-muted/70 focus:border-muted/50"
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={visible ? "Hide" : "Show"}
                        onClick={() => setVisible((v) => !v)}
                    >
                        {visible ? <EyeSlashIcon /> : <EyeIcon />}
                    </Button>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted/80">Saved to a private file; it never appears in the chat.</span>
                    <div className="flex items-center gap-1.5">
                        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void answer(null)}>
                            Decline
                        </Button>
                        <Button type="submit" size="sm" disabled={!value || busy}>
                            Save
                        </Button>
                    </div>
                </div>
            </form>
        </div>
    );
}
