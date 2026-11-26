import { PreviewCard } from "@base-ui/react/preview-card";
import { refreshClaude, useClaudeProvider } from "@/features/claude/store";
import { UsageCard } from "@/features/claude/UsageCard";
import {
    refreshUsage,
    tightestWindow,
    TONE_TEXT,
    USAGE_FRESH_MS,
    useClaudeUsage,
    usageTone,
    useUsagePolling
} from "@/features/claude/usage";
import { ClaudeMark } from "@/features/models/ClaudeMark";
import { settings, useSettingsStore } from "@/features/settings";
import { cn } from "@/lib/cn";
import { iconButtonClassName, Ring } from "@/ui";
import { popupClassName } from "@/ui/chip";

/**
 * Claude's plan usage in the dock, when Settings › Providers turns it on: a
 * ring around its mark for the most-used window; resting on it shows every
 * window, a click opens Providers.
 */
export function DockUsage({ side }: { side: "left" | "right" }) {
    const shown = useSettingsStore((s) => s.settings.claude.showUsageInDock);
    useUsagePolling(shown);
    if (!shown) return null;
    return <UsageButton side={side} />;
}

function UsageButton({ side }: { side: "left" | "right" }) {
    const windows = useClaudeUsage((s) => s.windows);
    const top = tightestWindow(windows);
    const used = top?.used ?? 0;
    const label = top ? `Claude usage: ${top.label} ${Math.round(used * 100)}%` : "Claude usage";

    return (
        <PreviewCard.Root
            onOpenChange={(open) => {
                if (!open) return;
                void refreshUsage({ maxAge: USAGE_FRESH_MS });
                if (!useClaudeProvider.getState().status) void refreshClaude();
            }}
        >
            <PreviewCard.Trigger
                delay={200}
                closeDelay={150}
                render={
                    <button
                        type="button"
                        aria-label={label}
                        onClick={() => settings.open("providers")}
                        className={cn(iconButtonClassName, "size-8")}
                    />
                }
            >
                <span className="relative flex size-8 items-center justify-center">
                    <Ring
                        fraction={used}
                        radius={6.8}
                        thickness={1.1}
                        className={cn("absolute inset-0 size-full", TONE_TEXT[usageTone(used)])}
                    />
                    <ClaudeMark className="size-3.5" />
                </span>
            </PreviewCard.Trigger>
            <PreviewCard.Portal>
                <PreviewCard.Positioner side={side} align="end" sideOffset={10} collisionPadding={12}>
                    <PreviewCard.Popup className={cn(popupClassName, "w-72 p-3")}>
                        <UsageCard />
                    </PreviewCard.Popup>
                </PreviewCard.Positioner>
            </PreviewCard.Portal>
        </PreviewCard.Root>
    );
}
