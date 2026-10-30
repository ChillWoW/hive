import type { ComponentType } from "react";
import { ShortcutKeys, useBinding, type ActionId } from "@/keybindings";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { FolderTreeIcon } from "@/ui";
import { HistoryTab } from "@/history/HistoryTab";
import { CommitTab } from "./CommitTab";
import { DiffTab } from "./DiffTab";
import { FileTab } from "./FileTab";
import { NEW_TABS } from "./kinds";
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
            ) : tab?.kind === "diff" ? (
                <DiffTab key={tab.id} />
            ) : tab?.kind === "history" ? (
                <HistoryTab key={tab.id} />
            ) : tab?.kind === "commit" ? (
                <CommitTab key={tab.id} tab={tab} />
            ) : (
                <EmptyTabs />
            )}
        </div>
    );
}

/** No tab open: what can be opened here, one row each. */
function EmptyTabs() {
    return (
        <div className="flex flex-1 items-center justify-center p-4">
            <div className="flex w-full max-w-64 flex-col gap-1">
                {NEW_TABS.map(({ label, hint, icon, shortcut, open }) => (
                    <Choice
                        key={label}
                        icon={icon}
                        label={label}
                        hint={hint}
                        shortcut={shortcut}
                        onClick={open}
                    />
                ))}
                <Choice
                    icon={FolderTreeIcon}
                    label="Files"
                    hint="Open one from the file panel"
                    onClick={() => useLayoutStore.getState().show("files")}
                />
            </div>
        </div>
    );
}

function Choice({
    icon: ChoiceIcon,
    label,
    hint,
    shortcut,
    onClick
}: {
    icon: ComponentType<{ className?: string }>;
    label: string;
    hint: string;
    shortcut?: ActionId;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-dark-700 focus-visible:bg-dark-700 focus-visible:outline-none"
        >
            <ChoiceIcon className="size-4 shrink-0 text-dark-250 group-hover:text-dark-100" />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[12.5px] text-dark-100">{label}</span>
                <span className="truncate text-[11px] text-dark-250">{hint}</span>
            </span>
            {shortcut && <Shortcut id={shortcut} />}
        </button>
    );
}

function Shortcut({ id }: { id: ActionId }) {
    return <ShortcutKeys shortcut={useBinding(id)} variant="plain" className="shrink-0" />;
}
