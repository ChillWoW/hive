import { useEffect, useState, type KeyboardEvent } from "react";
import { ACTIONS, CATEGORIES, type Action, type CategoryId } from "@/keybindings/actions";
import { ShortcutKeys } from "@/keybindings/ShortcutKeys";
import {
    canonical,
    checkAssignable,
    shortcutFromEvent,
    stringifyShortcut
} from "@/keybindings/shortcut";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import type { SendKey } from "@/proto";
import { SegmentedControl } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting, useSettingsStore } from "../store";

const MOD = isMac ? "⌘" : "Ctrl";

export function KeyboardPage() {
    const sendWith = useSetting("keyboard", "sendWith");
    const enterSends = sendWith.value === "enter";

    return (
        <>
            {CATEGORIES.filter((category) => category.id !== "prompt").map((category) => (
                <SettingsSection key={category.id} title={category.title}>
                    <ShortcutRows category={category.id} />
                </SettingsSection>
            ))}

            <SettingsSection title="Prompt box">
                <ShortcutRows category="prompt" />
                <SettingRow
                    label="Send with"
                    description={
                        enterSends
                            ? "Shift+Enter starts a new line"
                            : "Enter starts a new line"
                    }
                    keywords="send submit enter return newline line break composer"
                    setting={sendWith}
                    controlClassName="w-auto"
                    control={
                        <SegmentedControl
                            size="sm"
                            value={sendWith.value}
                            onValueChange={(value) => sendWith.set(value as SendKey)}
                            aria-label="Send with"
                        >
                            <SegmentedControl.Item value="enter">Enter</SegmentedControl.Item>
                            <SegmentedControl.Item value="mod-enter">
                                {MOD}+Enter
                            </SegmentedControl.Item>
                        </SegmentedControl>
                    }
                />
                <SettingRow
                    label="Stop the running turn"
                    keywords="stop interrupt cancel escape abort"
                    controlClassName="w-auto"
                    control={<ShortcutKeys shortcut="Escape" />}
                />
                <SettingRow
                    label="Slash commands"
                    keywords="slash commands menu"
                    controlClassName="w-auto"
                    control={<ShortcutKeys shortcut="/" />}
                />
            </SettingsSection>
        </>
    );
}

function ShortcutRows({ category }: { category: CategoryId }) {
    return ACTIONS.filter((action) => action.category === category).map((action) => (
        <ShortcutRow key={action.id} action={action} />
    ));
}

/**
 * One action: click its keys to record new ones. While recording, Escape
 * cancels and Backspace unbinds. Taking a shortcut another action has
 * unbinds that one, and the row says so.
 */
function ShortcutRow({ action }: { action: Action }) {
    const setting = useSetting("keyboard", action.id);
    const [recording, setRecording] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    useEffect(() => {
        if (!note) return;
        const timer = setTimeout(() => setNote(null), 3000);
        return () => clearTimeout(timer);
    }, [note]);

    const assign = (text: string) => {
        setRecording(false);
        const { settings, update } = useSettingsStore.getState();
        const combo = canonical(text);
        const taken = combo
            ? ACTIONS.filter(
                  (other) =>
                      other.id !== action.id &&
                      canonical(settings.keyboard[other.id]) === combo
              )
            : [];
        void update({
            keyboard: {
                [action.id]: text,
                ...Object.fromEntries(taken.map((other) => [other.id, ""]))
            }
        });
        setNote(
            taken.length
                ? `Removed from ${taken.map((other) => other.label).join(", ")}`
                : null
        );
    };

    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!recording) return;
        // Every key belongs to the recorder now, not the modal or the app.
        event.preventDefault();
        event.stopPropagation();
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (plain && event.key === "Escape") {
            setRecording(false);
            return;
        }
        if (plain && (event.key === "Backspace" || event.key === "Delete")) {
            assign("");
            return;
        }
        const pressed = shortcutFromEvent(event.nativeEvent);
        if (!pressed) return;
        const check = checkAssignable(pressed);
        if (!check.ok) {
            setNote(check.reason);
            return;
        }
        assign(stringifyShortcut(pressed));
    };

    const bound = canonical(setting.value) !== null;

    return (
        <SettingRow
            label={action.label}
            description={
                note ? (
                    <span className="text-warning">{note}</span>
                ) : (
                    action.description
                )
            }
            keywords={`${action.keywords} shortcut keybinding hotkey ${setting.value}`}
            setting={setting}
            control={
                <button
                    type="button"
                    aria-label={`${action.label} shortcut`}
                    aria-pressed={recording}
                    onClick={() => {
                        setNote(null);
                        setRecording((on) => !on);
                    }}
                    onKeyDown={onKeyDown}
                    onBlur={() => setRecording(false)}
                    className={cn(
                        "flex h-7 min-w-24 items-center justify-end rounded-md border px-1.5 text-xs transition-colors",
                        recording
                            ? "border-dark-400 bg-dark-700 text-dark-100"
                            : "border-transparent hover:border-dark-500 hover:bg-dark-700"
                    )}
                >
                    {recording ? (
                        <span className="px-1">Press keys…</span>
                    ) : bound ? (
                        <ShortcutKeys shortcut={setting.value} />
                    ) : (
                        <span className="px-1 text-dark-250">Unassigned</span>
                    )}
                </button>
            }
        />
    );
}
