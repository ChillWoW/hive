import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon, PaperclipIcon, StopIcon } from "@phosphor-icons/react";
import type { Attachment, ChatConfig, SlashCommand } from "@/proto";
import { AttachmentChip, attachFile } from "@/features/chats";
import { ModelPicker } from "@/features/models";
import { useSettingsStore, type BusySend } from "@/features/settings";
import { cn } from "@/lib/cn";
import { useResizeObserver } from "@/lib/useResizeObserver";
import { Spinner, toast, Tooltip } from "@/ui";
import { pickerTriggerClassName } from "@/ui/chip";
import { AccessPicker } from "./AccessPicker";
import { matchCommands, slashQuery, useCommands } from "./commands";
import { usePromptHistory } from "./history";
import { PromptField, type PromptFieldHandle } from "./PromptField";
import { SlashMenu } from "./SlashMenu";
import { addDraftAttachments, composer, useComposerStore, useDraft, useDraftAttachments } from "./store";

/** How long the box takes to reflow between its one-row and two-row shapes. */
const MORPH_MS = 200;
/** The frame's height easing, so the field slides in step with the edge. */
const MORPH_EASING = "cubic-bezier(0.22,1,0.36,1)";

type Mode = "send" | "stop";

const MODES: Record<Mode, { label: string; icon: typeof ArrowUpIcon }> = {
    send: { label: "Send", icon: ArrowUpIcon },
    stop: { label: "Stop", icon: StopIcon }
};

/** What sending while a turn runs is called, by `chat.busySend`. */
const BUSY_COPY: Record<BusySend, { placeholder: string; action: string; tooltip: string }> = {
    queue: { placeholder: "Queue a follow-up", action: "Queue", tooltip: "Queue: sends when this turn ends" },
    "after-tool": {
        placeholder: "Send after the current tool call",
        action: "Send after tool call",
        tooltip: "Sends once the running tool call finishes"
    },
    interrupt: { placeholder: "Stop and send a new prompt", action: "Stop and send", tooltip: "Stop the turn and send" }
};

/**
 * The prompt box: the field, the model picker (reasoning and fast mode in
 * it), and one button that is Send while idle and Stop while a turn runs.
 *
 * While what is typed fits on one line the field sits beside the controls.
 * Once it wouldn't — or holds a newline — the box turns into two rows, the
 * field across the full width above and the controls below, and animates
 * its height through the change. The controls sit on the bottom row in both
 * shapes and the box grows from its top edge, so they stay put while the
 * field slides between its two places. Past that the field grows to twelve
 * rows and scrolls.
 *
 * Enter sends, Shift+Enter breaks the line, Escape stops a running turn,
 * ↑/↓ in an empty field walk the prompts sent before. The text lives in the
 * composer store, one draft per chat, so it survives the box unmounting.
 */
export function Composer({
    chatId,
    cwd = "",
    config,
    onConfigChange,
    busy = false,
    onSend,
    onStop,
    placeholder,
    className
}: {
    /** Whose draft the field holds; null is the new-chat view. */
    chatId: string | null;
    /** The folder the chat works in: where `/` looks for commands. */
    cwd?: string;
    config: ChatConfig;
    onConfigChange: (config: ChatConfig) => void;
    /** The agent is working on a turn: a prompt sent now is queued. */
    busy?: boolean;
    /** False keeps the draft: the prompt couldn't be sent. */
    onSend: (prompt: string, attachments: Attachment[]) => boolean | void;
    onStop?: () => void;
    placeholder?: string;
    className?: string;
}) {
    const busySend = useSettingsStore((s) => s.settings.chat.busySend);
    const busyCopy = BUSY_COPY[busySend];
    placeholder ??= busy ? busyCopy.placeholder : "Ask anything";
    const draft = useDraft(chatId);
    const setDraft = (text: string) => composer.setDraft(chatId, text);
    const attachments = useDraftAttachments(chatId);
    const [uploading, setUploading] = useState(0);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    /** Copies `files` and attaches them to the draft. */
    const attach = async (files: File[]) => {
        if (files.length === 0) return;
        setUploading((n) => n + files.length);
        const added: Attachment[] = [];
        for (const file of files) {
            try {
                added.push(await attachFile(file));
            } catch (error) {
                toast.error({
                    title: `Couldn't attach ${file.name || "the file"}`,
                    description: error instanceof Error ? error.message : String(error)
                });
            }
        }
        setUploading((n) => n - files.length);
        if (added.length) addDraftAttachments(chatId, added);
    };
    const removeAttachment = (path: string) =>
        useComposerStore.getState().setAttachments(
            chatId,
            attachments.filter((a) => a.path !== path)
        );

    // `/` at the start lists the commands and skills.
    const commands = useCommands(chatId, cwd);
    const query = slashQuery(draft);
    const matches = query === undefined ? [] : matchCommands(commands, query);
    // Which match is highlighted, for the query it was picked at: a new query starts at the top.
    const [highlight, setHighlight] = useState({ query, index: 0 });
    const highlighted = highlight.query === query ? Math.min(highlight.index, Math.max(matches.length - 1, 0)) : 0;
    const setHighlighted = (next: number | ((index: number) => number)) =>
        setHighlight({ query, index: typeof next === "function" ? next(highlighted) : next });
    /** The draft the menu was closed at (Escape); it opens again once that changes. */
    const [dismissedAt, setDismissedAt] = useState<string>();
    const menuOpen = matches.length > 0 && dismissedAt !== draft;
    const pickCommand = (command: SlashCommand) => {
        fill(`/${command.name} `);
        setDismissedAt(undefined);
    };
    const focusToken = useComposerStore((s) => s.focusToken);
    const fieldRef = useRef<PromptFieldHandle>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const deckRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLSpanElement>(null);
    const controlsRef = useRef<HTMLDivElement>(null);
    /** Width the controls take from the field in the one-row shape. */
    const chromeRef = useRef(0);
    /**
     * Widest the deck has been while the controls overflowed the one-row
     * shape. At or below it the box stays two rows whatever is typed.
     */
    const crampedAtRef = useRef(0);
    /**
     * Where the field's text began, from the deck's bottom-left corner, as
     * last laid out — what a shape change slides it from.
     */
    const slotRef = useRef<{ tall: boolean; x: number; y: number } | null>(null);

    const [tall, setTall] = useState(false);
    const [morphing, setMorphing] = useState(false);
    const [, setWidth] = useState(0);
    const rememberPrompt = usePromptHistory((s) => s.remember);
    /** The history entry ↑/↓ last put in the field, while browsing it. */
    const recallRef = useRef<{ index: number; text: string } | null>(null);
    useEffect(() => {
        recallRef.current = null;
    }, [chatId]);

    /** Puts `text` in the field, the caret at its end. */
    const fill = (text: string) => fieldRef.current?.setText(text);

    // Runs on mount too, so a fresh chat view starts with the caret here.
    useEffect(() => {
        fieldRef.current?.focus("end");
    }, [focusToken, chatId]);

    // Decides the shape. The text (or the placeholder, while there's none)
    // is measured on one line in a hidden span and compared against the room
    // the one-row shape leaves the field — only measurable while in that
    // shape, so it's remembered from there, which also keeps the shapes from
    // flipping back and forth at the edge.
    const measure = () => {
        const deck = deckRef.current;
        const field = fieldRef.current?.dom;
        const span = measureRef.current;
        const controls = controlsRef.current;
        if (!deck || !field || !span || !controls) return;

        // Fractional widths: rounded `clientWidth`s can say the text fits
        // while it is already wrapping by a fraction of a pixel.
        const deckWidth = deck.getBoundingClientRect().width;
        if (!tall) {
            chromeRef.current = deckWidth - field.getBoundingClientRect().width;
            // The picker spilling out of its column, or its label spilling
            // out of its button once the model name has truncated away.
            const buttons = controls.querySelectorAll(":scope > button");
            const overflowing =
                controls.scrollWidth > controls.clientWidth ||
                Array.from(buttons).some((button) => button.scrollWidth > button.clientWidth);
            if (overflowing) crampedAtRef.current = Math.max(crampedAtRef.current, deckWidth);
        }
        const style = getComputedStyle(field);
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const room = deckWidth - chromeRef.current - padding;
        const next =
            deckWidth <= crampedAtRef.current ||
            draft.includes("\n") ||
            span.getBoundingClientRect().width > room;

        if (next !== tall) {
            setTall(next);
            setMorphing(true);
        }
    };

    // Slides the field from where the last shape had it to where this one
    // does (FLIP), rather than letting it jump. Measured from the deck's
    // bottom, where the frame anchors it, so the slide tracks the frame's
    // growing or shrinking top edge.
    useLayoutEffect(() => {
        const deck = deckRef.current;
        const field = fieldRef.current?.dom;
        if (!deck || !field) return;
        const slot = {
            tall,
            x: field.offsetLeft + parseFloat(getComputedStyle(field).paddingLeft),
            y: field.offsetTop - deck.offsetHeight
        };
        const previous = slotRef.current;
        slotRef.current = slot;
        if (!previous || previous.tall === tall) return;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const dx = previous.x - slot.x;
        const dy = previous.y - slot.y;
        field.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
            duration: MORPH_MS,
            easing: MORPH_EASING
        });
    });

    useLayoutEffect(measure);

    useEffect(() => {
        if (!morphing) return;
        const timer = window.setTimeout(() => setMorphing(false), MORPH_MS);
        return () => window.clearTimeout(timer);
    }, [morphing]);

    // The frame's height is set from the deck's so it has something to
    // transition between; the transition is only on while the shape changes,
    // so line-by-line growth stays instant. Written straight to the element:
    // the observer runs before paint, whereas a state update would clip the
    // new line for a frame. Width goes through state so resizing the window
    // re-renders and re-runs `measure` against the new room.
    useResizeObserver(deckRef, (deck) => {
        const frame = frameRef.current;
        if (!frame) return;
        frame.style.height = `${deck.offsetHeight}px`;
        setWidth(deck.clientWidth);
    });

    const prompt = draft.trim();
    const canSend = (!!prompt || attachments.length > 0) && uploading === 0;
    // While a turn runs, Stop until something is typed; then Send queues it
    // and Stop moves beside it.
    const mode: Mode = busy && onStop && !canSend ? "stop" : "send";
    const disabled = mode === "send" && !canSend;

    const submit = () => {
        if (mode === "stop") {
            onStop?.();
            return;
        }
        if (!canSend) return;
        if (onSend(prompt, attachments) !== false) {
            fill("");
            useComposerStore.getState().setAttachments(chatId, []);
            if (prompt) rememberPrompt(prompt);
            recallRef.current = null;
        }
    };

    /**
     * ↑ in an empty field brings back the last prompt sent, ↑ again older
     * ones, ↓ newer ones and then the empty field again — as long as the
     * recalled text is left as it is. In a multi-line one the caret first
     * moves line by line, as usual, until it's on the first (↑) or last (↓).
     */
    const recall = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
        if (event.nativeEvent.isComposing) return false;
        const field = event.currentTarget;
        const { selectionStart, selectionEnd } = field;
        if (selectionStart !== selectionEnd) return false;
        const current = recallRef.current;
        const browsing = current !== null && draft === current.text;
        if (!browsing && draft !== "") return false;
        const index = browsing ? current.index : -1;
        const entries = usePromptHistory.getState().entries;

        if (event.key === "ArrowUp") {
            if (draft.lastIndexOf("\n", selectionStart - 1) !== -1) return false;
            const next = index + 1;
            if (next >= entries.length) return browsing;
            recallRef.current = { index: next, text: entries[next]! };
            fill(entries[next]!);
            return true;
        }
        if (!browsing) return false;
        if (draft.indexOf("\n", selectionEnd) !== -1) return false;
        const next = index - 1;
        const text = next < 0 ? "" : entries[next]!;
        recallRef.current = next < 0 ? null : { index: next, text };
        fill(text);
        return true;
    };

    /** The command menu's keys, while it's open; true when one was taken. */
    const menuKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!menuOpen || event.nativeEvent.isComposing) return false;
        switch (event.key) {
            case "ArrowDown":
                setHighlighted((i) => (i + 1) % matches.length);
                return true;
            case "ArrowUp":
                setHighlighted((i) => (i - 1 + matches.length) % matches.length);
                return true;
            case "Tab":
            case "Enter": {
                if (event.shiftKey) return false;
                const command = matches[highlighted];
                // A full name typed already: Enter sends it as is.
                if (event.key === "Enter" && command?.name === query) return false;
                if (command) pickCommand(command);
                return true;
            }
            case "Escape":
                setDismissedAt(draft);
                event.stopPropagation();
                return true;
            default:
                return false;
        }
    };

    /** The field's keys, before its own; true when one was taken. */
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (menuKey(event)) return true;
        // Shift+Tab toggles plan mode, as in Claude Code.
        if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            onConfigChange({ ...config, plan: !config.plan });
            return true;
        }
        if (recall(event)) return true;
        if (event.key !== "Enter" || event.shiftKey) return false;
        // Enter mid-composition is the IME accepting a candidate.
        if (event.nativeEvent.isComposing) return false;
        // Enter never stops a turn; that takes the button or Escape. While a
        // turn runs it queues the prompt.
        if (canSend) submit();
        return true;
    };

    /** Pasted files (screenshots, copied files) are attached rather than typed. */
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return;
        event.preventDefault();
        void attach(files);
    };

    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

    const { label, icon: ModeIcon } = MODES[mode];

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && busy && onStop) {
                    event.preventDefault();
                    onStop();
                }
            }}
            onDragOver={(event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDragging(true);
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                setDragging(false);
                void attach(Array.from(event.dataTransfer.files));
            }}
            className={cn(
                "@container/composer relative flex w-full flex-col gap-1.5 rounded-[22px] border border-border bg-surface p-1.5",
                "transition-colors",
                dragging
                    ? "border-accent/60 bg-accent/5"
                    : "focus-within:border-[color-mix(in_srgb,var(--border)_75%,var(--muted))]",
                className
            )}
        >
            {menuOpen && (
                <SlashMenu
                    commands={matches}
                    highlighted={highlighted}
                    onHighlight={setHighlighted}
                    onPick={pickCommand}
                />
            )}
            {(attachments.length > 0 || uploading > 0) && (
                <div className="flex flex-wrap items-end gap-1.5 px-1 pt-1">
                    {attachments.map((attachment) => (
                        <AttachmentChip
                            key={attachment.path}
                            attachment={attachment}
                            onRemove={() => removeAttachment(attachment.path)}
                        />
                    ))}
                    {uploading > 0 && (
                        <span className="flex h-9 items-center gap-1.5 px-2 text-xs text-muted">
                            <Spinner label="Attaching" className="size-3.5" />
                            Attaching
                        </span>
                    )}
                </div>
            )}
            <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                    void attach(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = "";
                }}
            />
            {/* Anchors the deck to its bottom, so while the height animates
                it is the top row that is revealed or hidden and the controls,
                on the bottom row in either shape, never move. */}
            <div
                ref={frameRef}
                data-morph={morphing || undefined}
                className={cn(
                    "-m-1.5 box-content flex flex-col justify-end overflow-hidden p-1.5",
                    "transition-[height] duration-0 ease-[cubic-bezier(0.22,1,0.36,1)]",
                    "data-morph:duration-200 motion-reduce:transition-none"
                )}
            >
                <div
                    ref={deckRef}
                    data-tall={tall || undefined}
                    // The field's column may not shrink below 8rem and the
                    // controls' may shrink to nothing, so a narrow box
                    // truncates the model name rather than the field — and
                    // once the rest no longer fits, `measure` goes two rows.
                    className="group/deck relative grid shrink-0 grid-cols-[auto_minmax(8rem,1fr)_minmax(0,auto)] items-end gap-x-1 data-tall:gap-y-1.5"
                >
                    <span
                        ref={measureRef}
                        aria-hidden="true"
                        className="invisible absolute text-sm leading-6 whitespace-pre"
                    >
                        {/* An empty field shows the placeholder, which has to
                            fit on the one row too. */}
                        {draft === "" ? placeholder : draft}
                    </span>

                    {/* Left of the field on one row; the bottom row's first control on two. */}
                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <button
                                    type="button"
                                    aria-label="Attach files"
                                    onClick={() => fileInputRef.current?.click()}
                                    className={cn(
                                        pickerTriggerClassName,
                                        "col-start-1 row-start-1 size-8 justify-center px-0 group-data-tall/deck:row-start-2"
                                    )}
                                >
                                    <PaperclipIcon className="size-4" />
                                </button>
                            }
                        />
                        <Tooltip.Content side="top">Attach files (or paste, or drop them here)</Tooltip.Content>
                    </Tooltip>

                    <PromptField
                        ref={fieldRef}
                        value={draft}
                        placeholder={placeholder}
                        onChange={(text) => {
                            setDraft(text);
                            if (dismissedAt !== undefined && text !== dismissedAt) setDismissedAt(undefined);
                        }}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        className="col-start-2 row-start-1 block w-full min-w-0 px-2 text-sm leading-6 text-text group-data-tall/deck:col-span-3 group-data-tall/deck:col-start-1 group-data-tall/deck:px-2.5"
                    />

                    <div
                        ref={controlsRef}
                        className="col-start-3 row-start-1 flex min-w-0 items-center justify-end gap-0.5 group-data-tall/deck:col-span-2 group-data-tall/deck:col-start-2 group-data-tall/deck:row-start-2"
                    >
                        <AccessPicker config={config} onChange={onConfigChange} />
                        <span className="hidden flex-1 group-data-tall/deck:block" />
                        <ModelPicker config={config} onChange={onConfigChange} />
                        {busy && onStop && mode === "send" && (
                            <Tooltip>
                                <Tooltip.Trigger
                                    render={
                                        <button
                                            type="button"
                                            aria-label="Stop"
                                            onClick={onStop}
                                            className="ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-hover text-text outline-none transition-colors hover:bg-border"
                                        >
                                            <StopIcon className="size-3.5" weight="fill" />
                                        </button>
                                    }
                                />
                                <Tooltip.Content side="top" shortcut="Escape">
                                    Stop
                                </Tooltip.Content>
                            </Tooltip>
                        )}
                        <Tooltip>
                            <Tooltip.Trigger
                                render={
                                    <button
                                        key={mode}
                                        type="submit"
                                        aria-label={busy && mode === "send" ? busyCopy.action : label}
                                        disabled={disabled}
                                        className={cn(
                                            "ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none select-none",
                                            "transition-[color,background-color,scale,opacity,filter] duration-200 ease-out active:scale-[0.96]",
                                            "starting:scale-90 starting:opacity-0 starting:blur-[2px]",
                                            "bg-accent text-accent-fg hover:opacity-90",
                                            "disabled:bg-hover disabled:text-muted/75 disabled:hover:opacity-100 disabled:active:scale-100"
                                        )}
                                    >
                                        <ModeIcon
                                            className={mode === "stop" ? "size-3.5" : "size-4"}
                                            weight={mode === "stop" ? "fill" : "bold"}
                                        />
                                    </button>
                                }
                            />
                            <Tooltip.Content side="top" shortcut={mode === "stop" ? "Escape" : "Enter"}>
                                {busy && mode === "send" ? busyCopy.tooltip : label}
                            </Tooltip.Content>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </form>
    );
}
