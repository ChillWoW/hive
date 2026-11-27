import { TerminalWindowIcon } from "@phosphor-icons/react";
import { FileTab } from "@/features/editor";
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
    // Diffs bring their own view.
    return <div role="tabpanel" className="min-h-0 flex-1 overflow-auto" />;
}

function Empty() {
    const shortcut = useBinding("newTerminal");
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
            <Button variant="outline" size="sm" onClick={() => openTerminal()} className="gap-2">
                <TerminalWindowIcon className="size-3.5" />
                New terminal
                <ShortcutKeys shortcut={shortcut} variant="plain" />
            </Button>
        </div>
    );
}
