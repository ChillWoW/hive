import { PencilSimpleLineIcon, XIcon } from "@phosphor-icons/react";
import { chats, useChatsStore } from "@/chats";
import { composer, type NewChatDraft } from "@/composer";
import { cn } from "@/lib/cn";
import { ROW_ACTION, rowClassName } from "./rows";

/**
 * A new chat's unsent prompt, listed in the sidebar so it can be picked up
 * again (as in Cursor's agent view). A click opens it in the new-chat view;
 * ✕ (on hover) throws it away.
 */
export function DraftRow({ draft }: { draft: NewChatDraft }) {
    const active = useChatsStore((s) => s.activeChatId === null) && draft.open;
    const label =
        draft.text.split("\n", 1)[0] ||
        (draft.files === 1 ? "1 file" : `${draft.files} files`);

    const open = () => {
        composer.openDraft(draft.key);
        chats.select(null);
        composer.focus();
    };

    return (
        <div className="group/chat relative">
            <button
                type="button"
                onClick={open}
                aria-current={active ? "page" : undefined}
                className={rowClassName(active)}
            >
                <span className="flex w-4 shrink-0 justify-center text-dark-250">
                    <PencilSimpleLineIcon className="size-3" />
                </span>
                <span className="min-w-0 flex-1 truncate group-hover/chat:pr-5">{label}</span>
            </button>
            <button
                type="button"
                onClick={() => composer.discardDraft(draft.key)}
                aria-label={`Discard draft "${label}"`}
                className={cn(ROW_ACTION, "right-1.5 group-hover/chat:opacity-100")}
            >
                <XIcon className="size-3" weight="bold" />
            </button>
        </div>
    );
}
