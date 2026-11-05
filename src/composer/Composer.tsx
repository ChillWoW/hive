import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    ArrowBendDownRightIcon,
    ArrowUpIcon,
    PaperclipIcon,
    QueueIcon,
    StopIcon
} from "@phosphor-icons/react";
import type { Attachment, ChatConfig, SlashCommand } from "@/proto";
import { AttachmentTile, SavedAttachmentTile } from "@/attachments";
import { COMPOSER_SCOPE, useBinding, useShortcut } from "@/keybindings/runtime";
import { canonical, shortcutFromEvent, stringifyShortcut } from "@/keybindings/shortcut";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { useResizeObserver } from "@/lib/useResizeObserver";
import { useSettingsStore } from "@/settings/store";
import { useWorkspaceFiles } from "@/files";
import { refreshCatalogs, useCatalog } from "@/harnesses";
import { useUsageStore } from "@/usage/store";
import { IconButton, Tooltip } from "@/ui";
import { type Handoff, ModelPicker } from "./ModelPicker";
import { AccessPicker } from "./AccessPicker";
import { MentionMenu } from "./MentionMenu";
import { SlashMenu } from "./SlashMenu";
import { appCommands, type AppCommandId, standaloneAppCommand } from "./slashCommands";
import { useMentionMenu } from "./useMentionMenu";
import { useSlashMenu } from "./useSlashMenu";
import {
    commentTokens,
    linesLabel,
    withDiffComments,
    withoutCommentTokens
} from "@/review/comments";
import { PromptField, type PromptFieldHandle } from "./PromptField";
import { TagFace, type TagComment } from "./TagChip";
import { tagPieces, type FoundTag } from "./tags";
import {
    composer,
    useComposerStore,
    useDraft,
    useDraftAttachments,
    useDraftComments
} from "./store";
import { usePromptHistory } from "./history";

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
    /** A locked chat's other harnesses in the model picker, each continuing it in a new chat. */
    handoff?: Handoff;
    /** Why a prompt can't go yet (a handoff summary being written); Send waits. */
    hold?: string;
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
    /**
     * False keeps the draft: the prompt couldn't be sent yet. `background`
     * (the `sendInBackground` shortcut): a new chat starts without being opened.
     */
    onSend: (
        prompt: string,
        attachments: Attachment[],
        options?: { background?: boolean }
    ) => boolean | void;
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
    handoff,
    hold,
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
    const comments = useDraftComments(chatId);
    const removeComment = useComposerStore((s) => s.removeComment);
    const takeComments = useComposerStore((s) => s.takeComments);
    const focusToken = useComposerStore((s) => s.focusToken);
    const fieldRef = useRef<PromptFieldHandle>(null);
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
    const [tags, setTags] = useState<FoundTag[]>([]);
    /** The caret sits at a tag's end, where the menus would read it as typed text. */
    const onTag = tags.some((t) => caret > t.from && caret <= t.to);
    /** What each comment's tag shows. */
    const commentFaces = useMemo(
        () =>
            new Map<string, TagComment>(
                comments.map((c) => [
                    c.id,
                    { path: c.path, lines: linesLabel(c.start, c.end), body: c.body }
                ])
            ),
        [comments]
    );
    const rememberPrompt = usePromptHistory((s) => s.remember);
    /** The history entry ↑/↓ last put in the field, while browsing it. */
    const recallRef = useRef<{ index: number; text: string } | null>(null);
    useEffect(() => {
        recallRef.current = null;
    }, [chatId]);

    /**
     * Puts `text` in the field, the caret at `at` (its end by default). A
     * menu's completion passes `open`: a name ending there is still being typed.
     */
    const fill = (text: string, at = text.length, open?: number) => {
        fieldRef.current?.setText(text, { caret: at, open });
        setDraft(text);
        setCaret(at);
    };

    const complete = (text: string, at: number) => fill(text, at, at);

    // A comment's tag undone back in after the comment was deleted.
    useEffect(() => {
        const known = new Set(comments.map((c) => c.id));
        if (commentTokens(draft).every((t) => known.has(t.id))) return;
        composer.setDraft(chatId, withoutCommentTokens(draft, (id) => !known.has(id)));
    }, [draft, comments, chatId]);

    const [modelOpen, setModelOpen] = useState(false);
    const planOffered = !!useCatalog(config.harness)?.capabilities.plan;
    const app = appCommands({ plan: planOffered, planOn: config.plan });

    /** Runs one of Hive's own `/` commands. */
    const runApp = (id: AppCommandId) => {
        switch (id) {
            case "model":
                void refreshCatalogs();
                setModelOpen(true);
                break;
            case "plan":
            case "default":
                if (planOffered) onConfigChange({ ...config, plan: id === "plan" });
                break;
            case "usage-limits": {
                const usage = useUsageStore.getState();
                usage.setMetric("limits");
                usage.setOpen(true);
                break;
            }
        }
    };

    const slash = useSlashMenu({
        draft,
        caret,
        commands,
        app,
        started: chatId !== null,
        attached: attachments.length > 0 || comments.length > 0,
        enabled: focused && !onTag,
        complete,
        onApp: runApp
    });

    // Listed while the field has focus, so the first `@` rarely waits.
    const files = useWorkspaceFiles(cwd, focused);
    const mention = useMentionMenu({
        draft,
        caret,
        entries: files,
        enabled: focused && !!cwd && !onTag,
        complete
    });

    // Runs on mount too, so a fresh chat view starts with the caret here.
    useEffect(() => {
        fieldRef.current?.focus();
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
        if (!fieldRef.current?.view) return false;
        fieldRef.current.focus("end");
    });
    const sendWith = useSettingsStore((s) => s.settings.keyboard.sendWith);
    const backgroundCombo = canonical(useBinding("sendInBackground"));

    // Decides the shape. The text (or the placeholder, while there's none)
    // is measured on one line in a hidden span
    // and compared against the room the one-row shape leaves the field —
    // only measurable while in that shape, so it's remembered from there,
    // which also keeps the shapes from flipping back and forth at the edge.
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
        field.animate(
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
    useResizeObserver(deckRef, (deck) => {
        const frame = frameRef.current;
        if (!frame) return;
        frame.style.height = `${deck.offsetHeight}px`;
        setWidth(deck.clientWidth);
    });

    const prompt = draft.trim();
    const content = prompt !== "" || attachments.length > 0 || comments.length > 0;
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
    const disabled = mode !== "stop" && (!content || !filesReady || !!hold);

    const submit = (background = false) => {
        if (mode === "stop") {
            onStop?.();
            return;
        }
        if (!content || !filesReady || hold) return;
        // `/plan` and the like on their own run here; they never reach the agent.
        const standalone =
            attachments.length === 0 && comments.length === 0
                ? standaloneAppCommand(prompt, [
                      "model",
                      "usage-limits",
                      ...(planOffered ? (["plan", "default"] as const) : [])
                  ])
                : null;
        if (standalone) {
            fill("");
            rememberPrompt(prompt);
            recallRef.current = null;
            runApp(standalone);
            return;
        }
        const sent = attachments.flatMap((a) => (a.attachment ? [a.attachment] : []));
        if (onSend(withDiffComments(prompt, comments), sent, { background }) !== false) {
            fill("");
            takeAttachments(chatId);
            takeComments(chatId);
            // History keeps the words; the comments went with this prompt.
            const words = withoutCommentTokens(prompt).trim();
            if (words) rememberPrompt(words);
            recallRef.current = null;
        }
    };

    /**
     * ↑ in an empty field brings back the last prompt sent, ↑ again older
     * ones, ↓ newer ones and then the empty field again — as long as the
     * recalled text is left as it is. In a multi-line one the caret first
     * moves line by line, as usual, until it's on the first (↑) or last (↓).
     */
    const recall = (event: KeyboardEvent) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
        if (event.isComposing) return false;
        const view = fieldRef.current?.view;
        if (!view) return false;
        const { from: selectionStart, to: selectionEnd } = view.state.selection.main;
        if (selectionStart !== selectionEnd) return false;
        const current = recallRef.current;
        const browsing = current !== null && draft === current.text;
        if (!browsing && (draft !== "" || attachments.length > 0 || comments.length > 0)) {
            return false;
        }
        const index = browsing ? current.index : -1;
        const entries = usePromptHistory.getState().entries;

        if (event.key === "ArrowUp") {
            if (draft.lastIndexOf("\n", selectionStart - 1) !== -1) return false;
            const next = index + 1;
            if (next >= entries.length) return browsing;
            recallRef.current = { index: next, text: entries[next] };
            fill(entries[next]);
            return true;
        }
        if (!browsing) return false;
        if (draft.indexOf("\n", selectionEnd) !== -1) return false;
        const next = index - 1;
        const text = next < 0 ? "" : entries[next];
        recallRef.current = next < 0 ? null : { index: next, text };
        fill(text);
        return true;
    };

    const attach = (files: File[]) => {
        if (files.length === 0) return;
        addFiles(chatId, files);
        fieldRef.current?.focus();
    };

    // Only a paste that carries files is taken over; text pastes as usual.
    const onPaste = (event: ClipboardEvent) => {
        if (!canAttach || !event.clipboardData) return false;
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return false;
        event.preventDefault();
        attach(files);
        return true;
    };

    // Only a drag carrying files is a drop target; dragged text passes
    // through to the field.
    const carriesFiles = (event: { dataTransfer: DataTransfer | null }) =>
        canAttach && !!event.dataTransfer?.types.includes("Files");

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

    /** The field's keys, before its own; true when one was taken. */
    const onKeyDown = (event: KeyboardEvent) => {
        if (mention.onKeyDown(event) || slash.onKeyDown(event) || recall(event)) {
            event.preventDefault();
            return true;
        }
        // Handled here, not by the window listener: the field's own keymap
        // would take Mod/Shift+Enter first.
        if (backgroundCombo && !event.isComposing) {
            const pressed = shortcutFromEvent(event);
            if (pressed && stringifyShortcut(pressed) === backgroundCombo) {
                event.preventDefault();
                if (content) submit(true);
                return true;
            }
        }
        if (event.key !== "Enter" || event.shiftKey) return false;
        // With Mod+Enter sending, a bare Enter is a new line.
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (sendWith === "mod-enter" && !mod) return false;
        // Enter mid-composition is the IME accepting a candidate.
        if (event.isComposing) return false;
        event.preventDefault();
        // Enter never stops a turn; that takes the button or Escape.
        if (content) submit();
        return true;
    };

    const { label: modeLabel, icon: ModeIcon } = MODES[mode];
    const label = hold && mode !== "stop" ? hold : modeLabel;

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
                            <SavedAttachmentTile
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
                        {/* An empty field shows the placeholder, which has to
                            fit on the one row too. */}
                        {draft === "" && placeholder}
                        {tagPieces(draft, tags).map((piece, i) =>
                            "tag" in piece ? (
                                <TagFace
                                    key={i}
                                    tag={piece.tag}
                                    comment={
                                        piece.tag.kind === "comment"
                                            ? commentFaces.get(piece.tag.ref)
                                            : undefined
                                    }
                                />
                            ) : (
                                piece.text
                            )
                        )}
                    </span>

                    {canAttach && (
                        <IconButton
                            label="Attach files"
                            side="top"
                            onClick={() => fileInputRef.current?.click()}
                            className="col-start-1 row-start-1 size-8 rounded-full group-data-tall/deck:row-start-2"
                        >
                            <PaperclipIcon className="size-4" />
                        </IconButton>
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
                    <PromptField
                        ref={fieldRef}
                        value={draft}
                        resetKey={chatId ?? "new"}
                        placeholder={placeholder}
                        comments={commentFaces}
                        onChange={setDraft}
                        onCaret={setCaret}
                        onFocusChange={setFocused}
                        onTags={setTags}
                        onCommentsRemoved={(ids) => ids.forEach((id) => removeComment(chatId, id))}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        carriesFiles={carriesFiles}
                        className={cn(
                            "row-start-1 block w-full min-w-0 text-sm leading-6 text-dark-50",
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
                            handoff={handoff}
                            open={modelOpen}
                            onOpenChange={setModelOpen}
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
