import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { ShortcutKeys, useBinding } from "@/keybindings";
import { cn } from "@/lib/cn";
import { StatusMark } from "@/sidebar/StatusMark";
import { timeAgo, useMinuteClock } from "@/sidebar/time";
import { Modal } from "@/ui";
import { PREFIXES, usePaletteSections, type PaletteItem } from "./items";
import { usePaletteStore } from "./store";

/**
 * The command palette (Mod+K): recent chats and files, actions, and a search
 * over chats, the open folder's files and actions. Opens from the top.
 */
export function CommandPalette() {
    const isOpen = usePaletteStore((s) => s.isOpen);
    const setOpen = usePaletteStore((s) => s.setOpen);
    // A pick moves focus itself (a chat, a tab, the prompt); only a plain
    // close puts it back where it was.
    const picked = useRef(false);

    return (
        <Modal
            open={isOpen}
            onOpenChange={(open) => {
                if (open) picked.current = false;
                setOpen(open);
            }}
            showClose={false}
            size="xl"
            finalFocus={() => !picked.current}
            className="top-[10%] max-w-xl translate-y-0 overflow-hidden p-0"
            backdropClassName="bg-black/25"
        >
            <PaletteBody
                onPick={(item) => {
                    picked.current = true;
                    setOpen(false);
                    item.run();
                }}
            />
        </Modal>
    );
}

function PaletteBody({ onPick }: { onPick: (item: PaletteItem) => void }) {
    const [query, setQuery] = useState("");
    const sections = usePaletteSections(query);
    const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);
    const [activeId, setActiveId] = useState<string | null>(null);
    // The highlighted row, kept by id while the list changes under it.
    const index = Math.max(0, items.findIndex((i) => i.id === activeId));
    const active = items[index];
    const list = useRef<HTMLDivElement>(null);
    const keyboard = useRef(false);

    // A new search starts at the top.
    useEffect(() => setActiveId(null), [query]);

    useEffect(() => {
        if (!keyboard.current || !active) return;
        list.current
            ?.querySelector(`[data-item-id="${CSS.escape(active.id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const move = (by: number) => {
        if (!items.length) return;
        keyboard.current = true;
        setActiveId(items[(index + by + items.length) % items.length]!.id);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
        if (event.key === "ArrowDown" || (ctrl && event.key === "n")) move(1);
        else if (event.key === "ArrowUp" || (ctrl && event.key === "p")) move(-1);
        else if (event.key === "PageDown") move(8);
        else if (event.key === "PageUp") move(-8);
        else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            if (active) onPick(active);
        } else return;
        event.preventDefault();
    };

    let row = 0;
    return (
        <div className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-dark-700 px-3">
                <MagnifyingGlassIcon className="size-4 shrink-0 text-dark-250" />
                <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search chats, files and actions…"
                    aria-label="Command palette"
                    role="combobox"
                    aria-expanded
                    aria-controls="palette-list"
                    aria-activedescendant={active ? `palette-${index}` : undefined}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-11 min-w-0 flex-1 bg-transparent text-sm text-dark-50 outline-none placeholder:text-dark-400"
                />
            </div>

            <div
                ref={list}
                id="palette-list"
                role="listbox"
                onMouseMove={() => (keyboard.current = false)}
                className="max-h-[min(26rem,60vh)] overflow-y-auto p-1"
            >
                {sections.map((section) => (
                    <div key={section.id} role="group" aria-label={section.title}>
                        <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-dark-250">
                            {section.title}
                        </div>
                        {section.items.map((item) => {
                            const n = row++;
                            return (
                                <Row
                                    key={item.id}
                                    item={item}
                                    domId={`palette-${n}`}
                                    active={item === active}
                                    onHover={() => {
                                        if (!keyboard.current) setActiveId(item.id);
                                    }}
                                    onPick={() => onPick(item)}
                                />
                            );
                        })}
                    </div>
                ))}
                {!items.length && (
                    <div className="px-3 py-6 text-center text-xs text-dark-250">
                        Nothing matches
                    </div>
                )}
            </div>

            <div className="flex items-center gap-3 border-t border-dark-700 px-3 py-1.5 text-[11px] text-dark-250">
                <span>
                    <Key>↑↓</Key> to move
                </span>
                <span>
                    <Key>↵</Key> to open
                </span>
                <span className="ml-auto flex gap-3">
                    {PREFIXES.map((p) => (
                        <button
                            key={p.char}
                            type="button"
                            onClick={() => setQuery((q) => p.char + q.replace(/^[>#@]/, ""))}
                            className="cursor-pointer hover:text-dark-100"
                        >
                            <Key>{p.char}</Key> {p.label}
                        </button>
                    ))}
                </span>
            </div>
        </div>
    );
}

function Key({ children }: { children: string }) {
    return <kbd className="[font-family:inherit] font-medium text-dark-200">{children}</kbd>;
}

function Row({
    item,
    domId,
    active,
    onHover,
    onPick
}: {
    item: PaletteItem;
    domId: string;
    active: boolean;
    onHover: () => void;
    onPick: () => void;
}) {
    return (
        <div
            id={domId}
            role="option"
            aria-selected={active}
            data-item-id={item.id}
            onMouseMove={onHover}
            // Keeps focus in the field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPick}
            className={cn(
                "flex h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-xs text-dark-50",
                active && "bg-dark-700"
            )}
        >
            <span className="flex size-4 shrink-0 items-center justify-center text-dark-200 [&_img]:size-4 [&_svg]:size-4">
                {item.icon}
            </span>
            <span className="min-w-0 shrink truncate">{item.label}</span>
            {item.detail && (
                <span className="min-w-0 flex-1 truncate text-dark-250">{item.detail}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
                {item.chat && <ChatMeta {...item.chat} />}
                {item.shortcut && <Shortcut ref_={item.shortcut} />}
            </span>
        </div>
    );
}

function Shortcut({ ref_ }: { ref_: string }) {
    return <ShortcutKeys shortcut={useBinding(ref_)} variant="plain" />;
}

function ChatMeta({ status, at, archived }: NonNullable<PaletteItem["chat"]>) {
    const now = useMinuteClock();
    return (
        <>
            {archived && <span className="text-[11px] text-dark-400">Archived</span>}
            {status === "idle" ? (
                <span className="text-[11px] text-dark-250 tabular-nums">{timeAgo(at, now)}</span>
            ) : (
                <StatusMark status={status} />
            )}
        </>
    );
}
