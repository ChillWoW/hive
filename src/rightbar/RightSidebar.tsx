import { CubeIcon } from "@phosphor-icons/react";
import { useRightbarStore } from "./store";

/** The right sidebar: the shown tab (its tab strip is in the top bar above it). */
export function RightSidebar() {
    const tab = useRightbarStore((s) => s.tabs.find((t) => t.id === s.activeId));

    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 border-t border-dark-600 p-4 text-center">
            {tab ? (
                <>
                    <CubeIcon className="size-6 text-dark-300" />
                    <div className="text-[12.5px] text-dark-100">{tab.title}</div>
                    <div className="text-[11px] text-dark-250">A mock tab, nothing here yet</div>
                </>
            ) : (
                <div className="text-[11.5px] text-dark-250">No tabs open. Add one with +</div>
            )}
        </div>
    );
}
