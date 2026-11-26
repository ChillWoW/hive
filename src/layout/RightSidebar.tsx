import { SidePanel } from "./SidePanel";

/** The tabs panel (the right sidebar by default): tabs (files, terminals, diffs, …) to come. */
export function RightSidebar() {
    return (
        <SidePanel panel="tabs" label="Tabs">
            <div className="min-h-0 flex-1" />
        </SidePanel>
    );
}
