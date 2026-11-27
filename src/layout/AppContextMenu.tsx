import { useEffect, useState, type ReactNode } from "react";
import { ShortcutKeys, useBinding, useShortcut } from "@/keybindings";
import { copyText } from "@/lib/clipboard";
import { ContextMenu } from "@/ui";

/** What was under a right-click, as the menu's items need it. */
type Target = {
    /** The focused text field, if any. */
    field: HTMLElement | null;
    /** The selected text, in the field or on the page. */
    text: string;
    /** Whether the field takes edits (cut, paste). */
    editable: boolean;
};

const NOTHING: Target = { field: null, text: "", editable: false };

const isTextInput = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && el.type !== "password" && el.selectionStart !== null);

/**
 * Reads the focused field and selection. A right-click focuses the field it
 * lands on and blurs one it lands outside of, so focus says what was clicked;
 * a terminal has put its selection in its (focused) helper textarea by now.
 */
function readTarget(): Target {
    const active = document.activeElement;
    const selection = window.getSelection()?.toString() ?? "";
    if (!(active instanceof HTMLElement)) return { ...NOTHING, text: selection };
    if (isTextInput(active)) {
        return {
            field: active,
            text: active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0),
            // A terminal's text isn't the field's to cut.
            editable: !active.readOnly && !active.disabled
        };
    }
    if (active.isContentEditable) return { field: active, text: selection, editable: true };
    return { ...NOTHING, text: selection };
}

const inTerminal = (el: HTMLElement) => !!el.closest(".xterm");

/**
 * Pastes as Ctrl+V would: a paste event for editors that handle it themselves
 * (CodeMirror, the terminal), typed in for plain fields.
 */
async function paste(field: HTMLElement) {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (!text) return;
    field.focus();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    // The terminal takes the event without cancelling it.
    if (field.dispatchEvent(event) && !inTerminal(field)) document.execCommand("insertText", false, text);
}

function cut(field: HTMLElement) {
    field.focus();
    document.execCommand("cut");
}

const refresh = () => window.location.reload();

/**
 * The menu a right-click opens anywhere no other `ContextMenu` covers, in the
 * webview's own menu's place: text editing where it applies, and Refresh.
 * Wrap the whole app, modals included.
 */
export function AppContextMenu({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<Target>(NOTHING);
    const binding = useBinding("refresh");
    useShortcut("refresh", refresh);

    // Whatever React's tree doesn't cover still gets no webview menu.
    useEffect(() => {
        const block = (event: MouseEvent) => event.preventDefault();
        window.addEventListener("contextmenu", block);
        return () => window.removeEventListener("contextmenu", block);
    }, []);

    const { field, text, editable } = target;
    const cuts = !!field && editable && !!text && !inTerminal(field);

    return (
        <ContextMenu>
            <ContextMenu.Trigger
                className="contents select-auto"
                onContextMenu={(event) => {
                    // Inside an open menu: no menu of its own.
                    if (event.target instanceof Element && event.target.closest("[role='menu']")) {
                        event.preventDefault();
                        event.preventBaseUIHandler();
                        return;
                    }
                    setTarget(readTarget());
                }}
            >
                {children}
            </ContextMenu.Trigger>
            <ContextMenu.Content className="w-44 min-w-0" finalFocus={() => field ?? true}>
                {cuts && <ContextMenu.Item onClick={() => cut(field)}>Cut</ContextMenu.Item>}
                {text && <ContextMenu.Item onClick={() => void copyText(text)}>Copy</ContextMenu.Item>}
                {field && editable && (
                    <ContextMenu.Item onClick={() => void paste(field)}>Paste</ContextMenu.Item>
                )}
                {(text || (field && editable)) && <ContextMenu.Separator />}
                <ContextMenu.Item onClick={refresh}>
                    Refresh
                    <ContextMenu.Shortcut>
                        <ShortcutKeys shortcut={binding} variant="plain" />
                    </ContextMenu.Shortcut>
                </ContextMenu.Item>
            </ContextMenu.Content>
        </ContextMenu>
    );
}
