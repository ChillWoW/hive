import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
import type { ChatConfig } from "@/proto";
import { ModelPicker } from "@/features/models";
import { cn } from "@/lib/cn";
import { useResizeObserver } from "@/lib/useResizeObserver";
import { Tooltip } from "@/ui";
import { usePromptHistory } from "./history";
import { PromptField, type PromptFieldHandle } from "./PromptField";
import { composer, useComposerStore, useDraft } from "./store";

/** How long the box takes to reflow between its one-row and two-row shapes. */
const MORPH_MS = 200;
/** The frame's height easing, so the field slides in step with the edge. */
const MORPH_EASING = "cubic-bezier(0.22,1,0.36,1)";

type Mode = "send" | "stop";

const MODES: Record<Mode, { label: string; icon: typeof ArrowUpIcon }> = {
    send: { label: "Send", icon: ArrowUpIcon },
    stop: { label: "Stop", icon: StopIcon }
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
    config,
    onConfigChange,
    busy = false,
    onSend,
    onStop,
    placeholder = "Ask anything",
    className
}: {
    /** Whose draft the field holds; null is the new-chat view. */
    chatId: string | null;
    config: ChatConfig;
    onConfigChange: (config: ChatConfig) => void;
    /** The agent is working on a turn. */
    busy?: boolean;
    /** False keeps the draft: the prompt couldn't be sent. */
    onSend: (prompt: string) => boolean | void;
    onStop?: () => void;
    placeholder?: string;
    className?: string;
}) {
    const draft = useDraft(chatId);
    const setDraft = (text: string) => composer.setDraft(chatId, text);
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
    const mode: Mode = busy && onStop ? "stop" : "send";
    const disabled = mode === "send" && (!prompt || busy);

    const submit = () => {
        if (mode === "stop") {
            onStop?.();
            return;
        }
        if (!prompt || busy) return;
        if (onSend(prompt) !== false) {
            fill("");
            rememberPrompt(prompt);
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

    /** The field's keys, before its own; true when one was taken. */
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (recall(event)) return true;
        if (event.key !== "Enter" || event.shiftKey) return false;
        // Enter mid-composition is the IME accepting a candidate.
        if (event.nativeEvent.isComposing) return false;
        // Enter never stops a turn; that takes the button or Escape.
        if (prompt && !busy) submit();
        return true;
    };

    const { label, icon: ModeIcon } = MODES[mode];

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && mode === "stop") {
                    event.preventDefault();
                    onStop?.();
                }
            }}
            className={cn(
                "relative flex w-full flex-col gap-1.5 rounded-[22px] border border-border bg-surface p-1.5",
                "transition-colors focus-within:border-muted/40",
                className
            )}
        >
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
                    className="group/deck relative grid shrink-0 grid-cols-[minmax(8rem,1fr)_minmax(0,auto)] items-end gap-x-1 data-tall:gap-y-1.5"
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

                    <PromptField
                        ref={fieldRef}
                        value={draft}
                        placeholder={placeholder}
                        onChange={setDraft}
                        onKeyDown={onKeyDown}
                        className="col-start-1 row-start-1 block w-full min-w-0 px-2.5 text-sm leading-6 text-text group-data-tall/deck:col-span-2"
                    />

                    <div
                        ref={controlsRef}
                        className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-0.5 group-data-tall/deck:col-span-2 group-data-tall/deck:col-start-1 group-data-tall/deck:row-start-2"
                    >
                        <ModelPicker config={config} onChange={onConfigChange} />
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
                                {label}
                            </Tooltip.Content>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </form>
    );
}
