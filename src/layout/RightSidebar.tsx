import { PanelTabStrip, PanelTabView } from "@/features/panel-tabs";
import { SidePanel } from "./SidePanel";

/** The tabs panel (the right sidebar by default): its tabs (files, terminals, diffs, …) across the top, the shown one below. */
export function RightSidebar() {
    return (
        <SidePanel panel="tabs" label="Tabs">
            <PanelTabStrip />
            <PanelTabView />
        </SidePanel>
    );
}
