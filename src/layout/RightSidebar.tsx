import { SidePanel } from "./SidePanel";

/** The right column: tabs (files, terminals, diffs, …) to come. */
export function RightSidebar() {
    return (
        <SidePanel panel="right" label="Right sidebar">
            <div className="min-h-0 flex-1" />
        </SidePanel>
    );
}
