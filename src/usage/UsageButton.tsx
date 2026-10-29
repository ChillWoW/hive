import { ChartBarIcon } from "@phosphor-icons/react";
import { Button, Tooltip } from "@/ui";
import { useUsageStore } from "./store";

/** In the top bar's right corner, before the panel toggles; Mod+U (by default) does the same. */
export function UsageButton() {
    const isOpen = useUsageStore((s) => s.isOpen);
    const toggle = useUsageStore((s) => s.toggle);
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <Button
                        variant="ghost"
                        onClick={toggle}
                        aria-label="Usage"
                        aria-pressed={isOpen}
                        className="p-0 size-6"
                    >
                        <ChartBarIcon weight={isOpen ? "fill" : "regular"} className="size-4" />
                    </Button>
                }
            />
            <Tooltip.Content side="bottom" shortcut="openUsage">
                Usage
            </Tooltip.Content>
        </Tooltip>
    );
}
