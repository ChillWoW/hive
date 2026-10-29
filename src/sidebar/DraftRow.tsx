import { PencilSimpleLineIcon, XIcon } from "@phosphor-icons/react";
import { chats, useChatsStore } from "@/chats";
import { composer, type NewChatDraft } from "@/composer";
import { cn } from "@/lib/cn";

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
                className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md pr-1.5 pl-2 text-left text-xs outline-none",
                    "transition-colors duration-100",
                    "focus-visible:ring-1 focus-visible:ring-dark-400",
                    active
                        ? "bg-dark-700 text-dark-50"
                        : "text-dark-100 hover:bg-dark-800 hover:text-dark-50"
                )}
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
                className={cn(
                    "absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center",
                    "rounded-sm text-dark-200 outline-none",
                    "transition-[color,background-color,opacity] duration-100",
                    "hover:bg-dark-600 hover:text-dark-50 focus-visible:opacity-100",
                    "opacity-0 group-hover/chat:opacity-100"
                )}
            >
                <XIcon className="size-3" weight="bold" />
            </button>
        </div>
    );
}
