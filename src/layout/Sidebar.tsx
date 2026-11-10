import { SettingsButton } from "@/features/settings";
import { SidePanel } from "./SidePanel";

/** The left column: the project list (to come), settings at its foot. */
export function Sidebar() {
    return (
        <SidePanel side="left" label="Sidebar">
            <div className="min-h-0 flex-1" />
            <div className="flex shrink-0 flex-col px-2 py-1.5">
                <SettingsButton />
            </div>
        </SidePanel>
    );
}
