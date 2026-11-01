import { ChartBarIcon } from "@phosphor-icons/react";
import { BarButton } from "@/layout/BarButton";
import { useUsageStore } from "./store";

/** In the top bar's right corner, before the panel toggles; Mod+U (by default) does the same. */
export function UsageButton() {
    const isOpen = useUsageStore((s) => s.isOpen);
    const toggle = useUsageStore((s) => s.toggle);
    return (
        <BarButton label="Usage" shortcut="openUsage" onClick={toggle} pressed={isOpen}>
            <ChartBarIcon weight={isOpen ? "fill" : "regular"} className="size-4" />
        </BarButton>
    );
}
