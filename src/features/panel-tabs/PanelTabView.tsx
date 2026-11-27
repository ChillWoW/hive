import { useEffect, useRef } from "react";
import { ClockCounterClockwiseIcon, GitDiffIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { ChangesTab, openChangesTab, useCurrentFolder } from "@/features/changes";
import { FileTab, focusWhenShown } from "@/features/editor";
import { CommitTab, HistoryTab, openHistoryTab } from "@/features/history";
import { openTerminal, TerminalView } from "@/features/terminal";
import { ShortcutKeys, useBinding } from "@/keybindings";
import { Button } from "@/ui";
import { usePanelTabsStore, type PanelTab } from "./store";

/** The shown tab's content, or what can be opened when there's none. */
export function PanelTabView() {
    const tab = usePanelTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
    const panel = useFocusHandover(tab);
    if (!tab) return <Empty />;
    return (
        <div ref={panel} role="tabpanel" className="flex min-h-0 flex-1 flex-col">
            <Content tab={tab} />
        </div>
    );
}

function Content({ tab }: { tab: PanelTab }) {
    if (tab.kind === "terminal") return <TerminalView key={tab.id} id={tab.id} />;
    if (tab.kind === "file" && tab.file) {
        return <FileTab key={tab.id} id={tab.id} cwd={tab.file.cwd} path={tab.file.path} />;
    }
    if (tab.kind === "diff" && tab.diff) return <ChangesTab key={tab.id} id={tab.id} cwd={tab.diff.cwd} />;
    if (tab.kind === "history" && tab.history) {
        return <HistoryTab key={tab.id} id={tab.id} cwd={tab.history.cwd} />;
    }
    if (tab.kind === "commit" && tab.commit) {
        return (
            // A new commit in the same tab starts over: no old scroll or folds.
            <CommitTab key={`${tab.id}:${tab.commit.sha}`} id={tab.id} cwd={tab.commit.cwd} sha={tab.commit.sha} />
        );
    }
    return null;
}

/**
 * A tab that closes takes the focus with it, and the close-tab shortcut
 * would then close the chat's tab: when the focus was in the tabs panel, the
 * tab shown next gets it. Returns the ref for the tab's panel.
 */
function useFocusHandover(tab: PanelTab | undefined) {
    const panel = useRef<HTMLDivElement>(null);
    // Whether the focus was last put in the tabs panel (its strip counts: × is there).
    const within = useRef(false);

    useEffect(() => {
        const onFocusIn = (event: FocusEvent) => {
            within.current = !!panel.current?.parentElement?.contains(event.target as Node);
        };
        document.addEventListener("focusin", onFocusIn);
        return () => document.removeEventListener("focusin", onFocusIn);
    }, []);

    const id = tab?.id;
    const kind = tab?.kind;
    // A commit tab starts over on a new commit, dropping the focus too.
    const shown = tab?.commit ? `${id}:${tab.commit.sha}` : id;
    useEffect(() => {
        if (!id || !within.current) return;
        // Only when the focus went with what was shown, not when it's elsewhere by now.
        const focused = document.activeElement;
        if (focused && focused !== document.body) return;
        if (kind === "file") focusWhenShown(id);
        // A terminal focuses itself as it's shown.
        else if (kind !== "terminal") {
            (panel.current?.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
        }
    }, [shown, id, kind]);

    return panel;
}

function Empty() {
    const terminal = useBinding("newTerminal");
    const changes = useBinding("showChanges");
    const history = useBinding("showHistory");
    const folder = useCurrentFolder();
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center">
            {/* Grid sizes every button to the widest one, so labels and keys never overflow. */}
            <div className="grid gap-2">
                <Button variant="outline" size="sm" onClick={() => openTerminal()} className="justify-start gap-2">
                    <TerminalWindowIcon className="size-3.5" />
                    New terminal
                    <ShortcutKeys shortcut={terminal} variant="plain" className="ml-auto pl-4" />
                </Button>
                {folder && (
                    <Button variant="outline" size="sm" onClick={() => openChangesTab(folder)} className="justify-start gap-2">
                        <GitDiffIcon className="size-3.5" />
                        Show changes
                        <ShortcutKeys shortcut={changes} variant="plain" className="ml-auto pl-4" />
                    </Button>
                )}
                {folder && (
                    <Button variant="outline" size="sm" onClick={() => openHistoryTab(folder)} className="justify-start gap-2">
                        <ClockCounterClockwiseIcon className="size-3.5" />
                        Show history
                        <ShortcutKeys shortcut={history} variant="plain" className="ml-auto pl-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}
