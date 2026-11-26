import { useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import type { SecretRequest } from "@/proto";
import { chatsApi } from "@/features/chats/api";
import { Button, Input, toast } from "@/ui";
import { cardClassName } from "./cards";

/**
 * An agent asking for a secret (`request_secret`): its name, what it's for,
 * a masked field, Save or Decline. The value goes to a private file the agent reads;
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
        <form
            onSubmit={(event) => {
                event.preventDefault();
                if (value) void answer(value);
            }}
            className={cardClassName}
        >
            <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-text">{request.label}</span>
                <p className="text-sm leading-6 whitespace-pre-wrap text-muted">{request.reason}</p>
            </div>
            <Input.Group size="md">
                <Input
                    type={visible ? "text" : "password"}
                    value={value}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`${request.placeholder ?? "Paste it here"} (never shown in chat)`}
                    aria-label={request.label}
                    onChange={(event) => setValue(event.target.value)}
                />
                <Input.Addon>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-6 rounded text-muted hover:text-text"
                        aria-label={visible ? "Hide" : "Show"}
                        onClick={() => setVisible((v) => !v)}
                    >
                        {visible ? <EyeSlashIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                    </Button>
                </Input.Addon>
            </Input.Group>
            <div className="flex items-center justify-end gap-1.5">
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void answer(null)}>
                    Decline
                </Button>
                <Button type="submit" size="sm" disabled={!value || busy}>
                    Save
                </Button>
            </div>
        </form>
    );
}
