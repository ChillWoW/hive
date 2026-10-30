import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    ArrowBendDownRightIcon,
    ArrowUpIcon,
    PaperclipIcon,
    QueueIcon,
    StopIcon
} from "@phosphor-icons/react";
import TextareaAutosize from "react-textarea-autosize";
import type { Attachment, ChatConfig, SlashCommand } from "@/proto";
import { AttachmentTile, useAttachmentUrl } from "@/attachments";
import { COMPOSER_SCOPE, useShortcut } from "@/keybindings/runtime";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { useSettingsStore } from "@/settings/store";
import { useWorkspaceFiles } from "@/files";
import { iconButtonClassName, Tooltip } from "@/ui";
import { ModelPicker } from "./ModelPicker";
import { AccessPicker } from "./AccessPicker";
import { MentionMenu } from "./MentionMenu";
import { SlashMenu } from "./SlashMenu";
import { useMentionMenu } from "./useMentionMenu";
import { useSlashMenu } from "./useSlashMenu";
import { composer, useComposerStore, useDraft, useDraftAttachments } from "./store";

/** Past this the field scrolls. */
const MAX_ROWS = 12;

/** How long the box takes to reflow between its one-row and two-row shapes. */
const MORPH_MS = 200;
/** The frame's height easing, so the field slides in step with the edge. */
const MORPH_EASING = "cubic-bezier(0.22,1,0.36,1)";

type Mode = "send" | "queue" | "steer" | "stop";

const MODES: Record<Mode, { label: string; icon: typeof ArrowUpIcon }> = {
    send: { label: "Send", icon: ArrowUpIcon },
    queue: { label: "Queue — sent when the agent finishes", icon: QueueIcon },
    steer: { label: "Steer — sent to the running turn", icon: ArrowBendDownRightIcon },
    stop: { label: "Stop", icon: StopIcon }
};

type ComposerProps = {
    /** Whose draft the field holds; null is the new-chat view. */
    chatId: string | null;
    config: ChatConfig;
    onConfigChange: (config: ChatConfig) => void;
    /** A started chat keeps its harness; only its models are offered. */
    lockedHarness?: boolean;
    /** The agent is working on a turn. */
    busy?: boolean;
    /** The harness can stop a running turn. */
    canStop?: boolean;
    /** A prompt sent while busy reaches the running turn instead of waiting. */
    steering?: boolean;
    /** Typed as `/name`; completed from a menu above the box. */
    commands?: SlashCommand[];
    /** Where the agent works: its files are mentioned as `@path`. */
    cwd?: string | null;
    /** The harness takes files with a prompt: the attach button, paste and drop. */
    canAttach?: boolean;
    /** False keeps the draft: the prompt couldn't be sent yet. */
    onSend: (prompt: string, attachments: Attachment[]) => boolean | void;
    onStop?: () => void;
    placeholder?: string;
    className?: string;
};

/**
 * The prompt box: the field, the model (with reasoning) and access pickers, and
 * one button that is Send while idle, Queue (or Steer, when the harness
 * takes prompts mid-turn) once something is typed during a turn, and Stop
 * while a turn runs with nothing typed.
 *
 * While what is typed fits on one line the field sits beside the controls.
 * Once it wouldn't — or holds a newline — the box turns into two rows, the
 * field across the full width above and the controls below, and animates
 * its height through the change. The controls sit on the bottom row in both
 * shapes and the box grows from its top edge, so they stay put while the
 * field slides between its two places. Past that the field grows to
 * `MAX_ROWS` and scrolls.
 *
 * Enter sends, Shift+Enter breaks the line. The text lives in the composer
 * store, one draft per chat, so it survives the box unmounting.
 */
export function Composer({
    chatId,
    config,
    onConfigChange,
    lockedHarness,
    busy = false,
    canStop = false,
    steering = false,
    commands = [],
    cwd,
    canAttach = false,
    onSend,
    onStop,
    placeholder = "Ask anything",
    className
}: ComposerProps) {
    const draft = useDraft(chatId);
    const setDraft = (text: string) => composer.setDraft(chatId, text);
    const attachments = useDraftAttachments(chatId);
    const addFiles = useComposerStore((s) => s.addFiles);
    const removeAttachment = useComposerStore((s) => s.removeAttachment);
    const takeAttachments = useComposerStore((s) => s.takeAttachments);
    const focusToken = useComposerStore((s) => s.focusToken);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    /**
     * dragenter/dragleave fire for every child the pointer crosses, so the
     * box counts them rather than trusting any one leave to mean it's gone.
     */
    const dragDepthRef = useRef(0);
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
    const [focused, setFocused] = useState(false);
    const [caret, setCaret] = useState(0);

    /** Sets the field's text from a menu, with the caret at `at`. */
    const complete = (text: string, at: number) => {
        setDraft(text);
        setCaret(at);
        requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(at, at);
        });
    };

    const slash = useSlashMenu({
        draft,
        caret,
        commands,
        enabled: focused,
        complete
    });

    // Listed while the field has focus, so the first `@` rarely waits.
    const files = useWorkspaceFiles(cwd, focused);
    const mention = useMentionMenu({
        draft,
        caret,
        entries: files,
        enabled: focused && !!cwd,
        complete
    });

    // Runs on mount too, so a fresh chat view starts with the caret here.
    useEffect(() => {
        textareaRef.current?.focus();
    }, [focusToken, chatId]);

    // The window has `dragDropEnabled: false`, so the webview handles drops
    // itself, and a file dropped where nothing takes it navigates the webview
    // to that file, replacing the app. While the composer is here, stray
    // drops are eaten.
    useEffect(() => {
        const swallow = (event: DragEvent) => event.preventDefault();
        window.addEventListener("dragover", swallow);
        window.addEventListener("drop", swallow);
        return () => {
            window.removeEventListener("dragover", swallow);
            window.removeEventListener("drop", swallow);
        };
    }, []);

    useShortcut("focusComposer", () => {
        const el = textareaRef.current;
        if (!el) return false;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
    });
    const sendWith = useSettingsStore((s) => s.settings.keyboard.sendWith);

    // Decides the shape. The text is measured on one line in a hidden span
    // and compared against the room the one-row shape leaves the field —
    // only measurable while in that shape, so it's remembered from there,
    // which also keeps the shapes from flipping back and forth at the edge.
    const measure = () => {
        const deck = deckRef.current;
        const textarea = textareaRef.current;
        const span = measureRef.current;
        const controls = controlsRef.current;
        if (!deck || !textarea || !span || !controls) return;

        // Fractional widths: rounded `clientWidth`s can say the text fits
        // while it is already wrapping by a fraction of a pixel.
        const deckWidth = deck.getBoundingClientRect().width;
        if (!tall) {
            chromeRef.current = deckWidth - textarea.getBoundingClientRect().width;
            // The pickers spilling out of their column, or a picker's label
            // spilling out of its button once the model name has truncated
            // away. Buttons only: the model picker also renders a hidden
            // input whose value always overflows it.
            const buttons = controls.querySelectorAll(":scope > button");
            const overflowing =
                controls.scrollWidth > controls.clientWidth ||
                Array.from(buttons).some(
                    (button) => button.scrollWidth > button.clientWidth
                );
            if (overflowing) {
                crampedAtRef.current = Math.max(crampedAtRef.current, deckWidth);
            }
        }
        const style = getComputedStyle(textarea);
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
        const textarea = textareaRef.current;
        if (!deck || !textarea) return;
        const slot = {
            tall,
            x: textarea.offsetLeft + parseFloat(getComputedStyle(textarea).paddingLeft),
            y: textarea.offsetTop - deck.offsetHeight
        };
        const previous = slotRef.current;
        slotRef.current = slot;
        if (!previous || previous.tall === tall) return;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const dx = previous.x - slot.x;
        const dy = previous.y - slot.y;
        textarea.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
            { duration: MORPH_MS, easing: MORPH_EASING }
        );
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
    useLayoutEffect(() => {
        const frame = frameRef.current;
        const deck = deckRef.current;
        if (!frame || !deck) return;
        const observer = new ResizeObserver(() => {
            frame.style.height = `${deck.offsetHeight}px`;
            setWidth(deck.clientWidth);
        });
        observer.observe(deck);
        return () => observer.disconnect();
    }, []);

    const prompt = draft.trim();
    const content = prompt !== "" || attachments.length > 0;
    /** Every file is copied in; one still copying or failed holds the send. */
    const filesReady = attachments.every((a) => a.attachment);
    const mode: Mode = content
        ? busy
            ? steering
                ? "steer"
                : "queue"
            : "send"
        : busy && canStop && onStop
          ? "stop"
          : "send";
    const disabled = mode !== "stop" && (!content || !filesReady);

    const submit = () => {
        if (mode === "stop") {
            onStop?.();
            return;
        }
        if (!content || !filesReady) return;
        const files = attachments.flatMap((a) => (a.attachment ? [a.attachment] : []));
        if (onSend(prompt, files) !== false) {
            setDraft("");
            takeAttachments(chatId);
        }
    };

    const attach = (files: File[]) => {
        if (files.length === 0) return;
        addFiles(chatId, files);
        textareaRef.current?.focus();
    };

    // Only a paste that carries files is taken over; text pastes as usual.
    const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (!canAttach) return;
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return;
        event.preventDefault();
        attach(files);
    };

    // Only a drag carrying files is a drop target; dragged text passes
    // through to the field.
    const carriesFiles = (event: React.DragEvent) =>
        canAttach && event.dataTransfer.types.includes("Files");

    const onDragEnter = (event: React.DragEvent<HTMLFormElement>) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragging(true);
    };

    const onDragOver = (event: React.DragEvent<HTMLFormElement>) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (event: React.DragEvent<HTMLFormElement>) => {
        if (!carriesFiles(event)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
    };

    const onDrop = (event: React.DragEvent<HTMLFormElement>) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        attach(Array.from(event.dataTransfer.files));
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (mention.onKeyDown(event) || slash.onKeyDown(event)) {
            event.preventDefault();
            return;
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        // With Mod+Enter sending, a bare Enter is a new line.
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (sendWith === "mod-enter" && !mod) return;
        // Enter mid-composition is the IME accepting a candidate.
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        // Enter never stops a turn; that takes the button or Escape.
        if (content) submit();
    };

    const { label, icon: ModeIcon } = MODES[mode];

    return (
        <form
            {...COMPOSER_SCOPE}
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && mode === "stop" && !slash.open && !mention.open) {
                    event.preventDefault();
                    onStop?.();
                }
            }}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
                "relative flex w-full flex-col gap-1.5 rounded-[22px] border border-dark-700 bg-dark-850 p-1.5",
                "transition-colors focus-within:border-dark-600",
                className
            )}
        >
            {dragging && (
                // pointer-events-none so the overlay never becomes the drag
                // target itself and throws the enter/leave count off. One
                // pixel out, over the box's own border, with the same radius.
                <div
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute -inset-px z-10 flex items-center justify-center gap-2",
                        "rounded-[22px] border border-dark-500",
                        "bg-dark-850/90 text-sm text-dark-100 backdrop-blur-[2px]",
                        "transition-opacity duration-150 starting:opacity-0"
                    )}
                >
                    <PaperclipIcon className="size-4" />
                    Drop files to attach
                </div>
            )}
            {/* Above the box: in a chat the composer sits at the bottom of the window. */}
            <SlashMenu
                menu={slash}
                className="absolute inset-x-0 bottom-full z-20 mb-2"
            />
            <MentionMenu
                menu={mention}
                className="absolute inset-x-0 bottom-full z-20 mb-2"
            />
            {attachments.length > 0 && (
                <div className="flex flex-wrap items-end gap-2 px-1 pt-1">
                    {attachments.map((a) =>
                        !a.previewUrl && a.attachment ? (
                            <SavedTile
                                key={a.id}
                                attachment={a.attachment}
                                onRemove={() => removeAttachment(chatId, a.id)}
                            />
                        ) : (
                            <AttachmentTile
                                key={a.id}
                                name={a.name}
                                imageUrl={a.previewUrl}
                                uploading={!a.attachment && !a.error}
                                error={a.error}
                                onRemove={() => removeAttachment(chatId, a.id)}
                            />
                        )
                    )}
                </div>
            )}
            {/* Anchors the deck to its bottom, so while the height animates
                it's the top row that is revealed or hidden and the controls,
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
                    className={cn(
                        "group/deck relative grid shrink-0 items-end gap-x-1 data-tall:gap-y-1.5",
                        // The attach button takes a column of its own on the left.
                        canAttach
                            ? "grid-cols-[auto_minmax(8rem,1fr)_minmax(0,auto)]"
                            : "grid-cols-[minmax(8rem,1fr)_minmax(0,auto)]"
                    )}
                >
                    <span
                        ref={measureRef}
                        aria-hidden="true"
                        className="invisible absolute text-sm leading-6 whitespace-pre"
                    >
                        {draft}
                    </span>

                    {canAttach && (
                        <Tooltip>
                            <Tooltip.Trigger
                                render={
                                    <button
                                        type="button"
                                        aria-label="Attach files"
                                        onClick={() => fileInputRef.current?.click()}
                                        className={cn(
                                            iconButtonClassName,
                                            "col-start-1 row-start-1 size-8 rounded-full group-data-tall/deck:row-start-2"
                                        )}
                                    >
                                        <PaperclipIcon className="size-4" />
                                    </button>
                                }
                            />
                            <Tooltip.Content side="top">Attach files</Tooltip.Content>
                        </Tooltip>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        tabIndex={-1}
                        onChange={(event) => {
                            attach(Array.from(event.target.files ?? []));
                            // The same file can be picked again.
                            event.target.value = "";
                        }}
                    />
                    <TextareaAutosize
                        ref={textareaRef}
                        value={draft}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setCaret(event.target.selectionStart);
                        }}
                        onSelect={(event) =>
                            setCaret(event.currentTarget.selectionStart)
                        }
                        onFocus={() => setFocused(true)}
                        onBlur={() => setFocused(false)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        // Autosize only re-measures when it re-renders; without
                        // this it keeps the one-row shape's height after the
                        // field widens.
                        data-tall={tall || undefined}
                        placeholder={placeholder}
                        aria-label="Message"
                        minRows={1}
                        maxRows={MAX_ROWS}
                        rows={1}
                        className={cn(
                            "row-start-1 block w-full resize-none bg-transparent py-1",
                            "text-sm leading-6 text-dark-50 placeholder:text-dark-250",
                            canAttach
                                ? "col-start-2 pr-2.5 pl-1 group-data-tall/deck:col-span-3 group-data-tall/deck:col-start-1 group-data-tall/deck:px-2.5"
                                : "col-start-1 px-2.5 group-data-tall/deck:col-span-2"
                        )}
                    />

                    <div
                        ref={controlsRef}
                        className={cn(
                            "row-start-1 flex min-w-0 items-center justify-end gap-0.5 group-data-tall/deck:row-start-2",
                            canAttach
                                ? "col-start-3 group-data-tall/deck:col-span-2 group-data-tall/deck:col-start-2"
                                : "col-start-2 group-data-tall/deck:col-span-2 group-data-tall/deck:col-start-1"
                        )}
                    >
                        <AccessPicker config={config} onChange={onConfigChange} />
                        <ModelPicker
                            config={config}
                            onChange={onConfigChange}
                            locked={lockedHarness}
                        />
                        <Tooltip>
                            <Tooltip.Trigger
                                render={
                                    <button
                                        key={mode}
                                        type="submit"
                                        aria-label={label}
                                        disabled={disabled}
                                        className={cn(
                                            "ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none select-none",
                                            "transition-[color,background-color,scale,opacity,filter] duration-200 ease-out active:scale-[0.96]",
                                            "starting:scale-90 starting:opacity-0 starting:blur-[2px]",
                                            "bg-primary-100 text-dark-900 hover:bg-primary-300",
                                            "disabled:bg-dark-700 disabled:text-dark-250 disabled:active:scale-100"
                                        )}
                                    >
                                        <ModeIcon
                                            className={mode === "stop" ? "size-3.5" : "size-4"}
                                            weight={mode === "stop" ? "fill" : "bold"}
                                        />
                                    </button>
                                }
                            />
                            <Tooltip.Content
                                side="top"
                                shortcut={
                                    mode === "stop"
                                        ? "Escape"
                                        : sendWith === "mod-enter"
                                          ? "Mod+Enter"
                                          : "Enter"
                                }
                            >
                                {label}
                            </Tooltip.Content>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </form>
    );
}

/** A file already copied in without a preview (a restored draft): images read back. */
function SavedTile({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
    const imageUrl = useAttachmentUrl(attachment);
    return <AttachmentTile name={attachment.name} imageUrl={imageUrl} onRemove={onRemove} />;
}
