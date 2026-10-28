import { useEffect, useRef, useState } from "react";
import {
    ArrowBendDownRightIcon,
    ArrowUpIcon,
    QueueIcon,
    StopIcon
} from "@phosphor-icons/react";
import TextareaAutosize from "react-textarea-autosize";
import type { ChatConfig, SlashCommand } from "@/proto";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/ui";
import { ModelPicker } from "./ModelPicker";
import { AccessPicker } from "./AccessPicker";
import { ReasoningPicker } from "./ReasoningPicker";
import { SlashMenu } from "./SlashMenu";
import { useSlashMenu } from "./useSlashMenu";
import { composer, useComposerStore, useDraft } from "./store";

/** Past this the field scrolls. */
const MAX_ROWS = 12;

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
    /** False keeps the draft: the prompt couldn't be sent yet. */
    onSend: (prompt: string) => boolean | void;
    onStop?: () => void;
    placeholder?: string;
    className?: string;
};

/**
 * The prompt box: a field that grows with the text, and under it the model
 * and reasoning pickers and one button that is Send while idle, Queue (or
 * Steer, when the harness takes prompts mid-turn) once something is typed
 * during a turn, and Stop while a turn runs with nothing typed.
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
    onSend,
    onStop,
    placeholder = "Ask anything",
    className
}: ComposerProps) {
    const draft = useDraft(chatId);
    const setDraft = (text: string) => composer.setDraft(chatId, text);
    const focusToken = useComposerStore((s) => s.focusToken);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [focused, setFocused] = useState(false);

    const slash = useSlashMenu({
        draft,
        commands,
        enabled: focused,
        complete: (text) => {
            setDraft(text);
            requestAnimationFrame(() => {
                const el = textareaRef.current;
                el?.setSelectionRange(text.length, text.length);
            });
        }
    });

    // Runs on mount too, so a fresh chat view starts with the caret here.
    useEffect(() => {
        textareaRef.current?.focus();
    }, [focusToken, chatId]);

    const prompt = draft.trim();
    const mode: Mode = prompt
        ? busy
            ? steering
                ? "steer"
                : "queue"
            : "send"
        : busy && canStop && onStop
          ? "stop"
          : "send";
    const disabled = mode !== "stop" && !prompt;

    const submit = () => {
        if (mode === "stop") {
            onStop?.();
            return;
        }
        if (!prompt) return;
        if (onSend(prompt) !== false) setDraft("");
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (slash.onKeyDown(event)) {
            event.preventDefault();
            return;
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        // Enter mid-composition is the IME accepting a candidate.
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        // Enter never stops a turn; that takes the button or Escape.
        if (prompt) submit();
    };

    const { label, icon: ModeIcon } = MODES[mode];

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && mode === "stop" && !slash.open) {
                    event.preventDefault();
                    onStop?.();
                }
            }}
            className={cn(
                "relative flex w-full flex-col gap-1 rounded-[22px] border border-dark-700 bg-dark-850 p-1.5",
                "transition-colors focus-within:border-dark-600",
                className
            )}
        >
            <SlashMenu
                menu={slash}
                className="absolute inset-x-0 bottom-full z-20 mb-2"
            />
            <TextareaAutosize
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                aria-label="Message"
                minRows={1}
                maxRows={MAX_ROWS}
                className={cn(
                    "block w-full resize-none bg-transparent px-2.5 pt-1.5 pb-0.5",
                    "text-sm leading-6 text-dark-50 placeholder:text-dark-300"
                )}
            />
            <div className="flex min-w-0 items-center gap-0.5">
                <ModelPicker
                    config={config}
                    onChange={onConfigChange}
                    locked={lockedHarness}
                />
                <ReasoningPicker config={config} onChange={onConfigChange} />
                <AccessPicker config={config} onChange={onConfigChange} />
                <div className="flex-1" />
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
                                    "transition-[color,background-color,scale,opacity] duration-150 active:scale-[0.96]",
                                    "starting:scale-90 starting:opacity-0",
                                    "bg-primary-100 text-dark-900 hover:bg-primary-300",
                                    "disabled:bg-dark-700 disabled:text-dark-300 disabled:active:scale-100"
                                )}
                            >
                                <ModeIcon
                                    className={mode === "stop" ? "size-3.5" : "size-4"}
                                    weight={mode === "stop" ? "fill" : "bold"}
                                />
                            </button>
                        }
                    />
                    <Tooltip.Content side="top">{label}</Tooltip.Content>
                </Tooltip>
            </div>
        </form>
    );
}
