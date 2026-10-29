import { FileTab } from "./FileTab";
import { TerminalTab } from "./TerminalTab";
import { useDiskChecks } from "./useDiskChecks";
import { useRightbarStore } from "./store";

/** The right sidebar: the shown tab (its tab strip is in the top bar above it). */
export function RightSidebar() {
    const tab = useRightbarStore((s) => s.tabs.find((t) => t.id === s.activeId));
    useDiskChecks();

    return (
        <div className="flex min-h-0 flex-1 flex-col border-t border-dark-600">
            {tab?.kind === "file" ? (
                <FileTab key={tab.id} tab={tab} />
            ) : tab?.kind === "terminal" ? (
                <TerminalTab key={tab.id} tab={tab} />
            ) : (
                <div className="flex flex-1 items-center justify-center p-4 text-center text-[11.5px] text-dark-250">
                    No tabs open. Open a file from the file panel, or a terminal with +.
                </div>
            )}
        </div>
    );
}
