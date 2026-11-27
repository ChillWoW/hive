import { ClockCounterClockwiseIcon, GitDiffIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { ChangesTab, openChangesTab, useCurrentFolder } from "@/features/changes";
import { FileTab } from "@/features/editor";
import { CommitTab, HistoryTab, openHistoryTab } from "@/features/history";
import { openTerminal, TerminalView } from "@/features/terminal";
import { ShortcutKeys, useBinding } from "@/keybindings";
import { Button } from "@/ui";
import { usePanelTabsStore } from "./store";

/** The shown tab's content, or what can be opened when there's none. */
export function PanelTabView() {
    const tab = usePanelTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
    if (!tab) return <Empty />;
    if (tab.kind === "terminal") {
        return (
            <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
                <TerminalView key={tab.id} id={tab.id} />
            </div>
        );
    }
    if (tab.kind === "file" && tab.file) {
        return (
            <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
                <FileTab key={tab.id} id={tab.id} cwd={tab.file.cwd} path={tab.file.path} />
            </div>
        );
    }
    if (tab.kind === "diff" && tab.diff) {
        return (
            <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
                <ChangesTab key={tab.id} id={tab.id} cwd={tab.diff.cwd} />
            </div>
        );
    }
    if (tab.kind === "history" && tab.history) {
        return (
            <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
                <HistoryTab key={tab.id} id={tab.id} cwd={tab.history.cwd} />
            </div>
        );
    }
    if (tab.kind === "commit" && tab.commit) {
        return (
            <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
                {/* A new commit in the same tab starts over: no old scroll or folds. */}
                <CommitTab
                    key={`${tab.id}:${tab.commit.sha}`}
                    id={tab.id}
                    cwd={tab.commit.cwd}
                    sha={tab.commit.sha}
                />
            </div>
        );
    }
    return <div role="tabpanel" className="min-h-0 flex-1 overflow-auto" />;
}

function Empty() {
    const terminal = useBinding("newTerminal");
    const changes = useBinding("showChanges");
    const history = useBinding("showHistory");
    const folder = useCurrentFolder();
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => openTerminal()} className="w-44 gap-2">
                <TerminalWindowIcon className="size-3.5" />
                New terminal
                <ShortcutKeys shortcut={terminal} variant="plain" className="ml-auto" />
            </Button>
            {folder && (
                <Button variant="outline" size="sm" onClick={() => openChangesTab(folder)} className="w-44 gap-2">
                    <GitDiffIcon className="size-3.5" />
                    Show changes
                    <ShortcutKeys shortcut={changes} variant="plain" className="ml-auto" />
                </Button>
            )}
            {folder && (
                <Button variant="outline" size="sm" onClick={() => openHistoryTab(folder)} className="w-44 gap-2">
                    <ClockCounterClockwiseIcon className="size-3.5" />
                    Show history
                    <ShortcutKeys shortcut={history} variant="plain" className="ml-auto" />
                </Button>
            )}
        </div>
    );
}
