import { PreviewCard } from "@base-ui/react/preview-card";
import type { HarnessId } from "@/proto";
import { claude } from "@/features/claude/store";
import { UsageCard } from "@/features/claude/UsageCard";
import { tightestWindow, TONE_TEXT, USAGE_FRESH_MS, usageTone } from "@/features/claude/usage";
import { codex } from "@/features/codex/store";
import { HarnessMark } from "@/features/models/HarnessMark";
import type { Provider } from "@/features/providers/makeProvider";
import { settings, useSettingsStore } from "@/features/settings";
import { cn } from "@/lib/cn";
import { iconButtonClassName, Ring } from "@/ui";
import { popupClassName } from "@/ui/chip";

/**
 * The plans' usage in the dock, for each provider Settings › Providers turns
 * it on for: a ring around its mark for the most-used window; resting on it
 * shows every window, a click opens Providers.
 */
export function DockUsage({ side }: { side: "left" | "right" }) {
    const showClaude = useSettingsStore((s) => s.settings.claude.showUsageInDock);
    const showCodex = useSettingsStore((s) => s.settings.codex.showUsageInDock);
    claude.useUsagePolling(showClaude);
    codex.useUsagePolling(showCodex);
    return (
        <>
            {showClaude && (
                <UsageButton
                    side={side}
                    harness="claude"
                    provider={claude}
                    signedOutHint="Shown for a Claude subscription login"
                />
            )}
            {showCodex && (
                <UsageButton side={side} harness="codex" provider={codex} signedOutHint="Shown for a ChatGPT login" />
            )}
        </>
    );
}

function UsageButton({
    side,
    harness,
    provider,
    signedOutHint
}: {
    side: "left" | "right";
    harness: HarnessId;
    provider: Provider;
    signedOutHint: string;
}) {
    const windows = provider.useUsage((s) => s.windows);
    const top = tightestWindow(windows);
    const used = top?.used ?? 0;
    const name = `${provider.name} usage`;
    const label = top ? `${name}: ${top.label} ${Math.round(used * 100)}%` : name;

    return (
        <PreviewCard.Root
            onOpenChange={(open) => {
                if (!open) return;
                void provider.refreshUsage({ maxAge: USAGE_FRESH_MS });
                if (!provider.useProvider.getState().status) void provider.refresh();
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
                    <HarnessMark harness={harness} className="size-3.5" />
                </span>
            </PreviewCard.Trigger>
            <PreviewCard.Portal>
                <PreviewCard.Positioner side={side} align="end" sideOffset={10} collisionPadding={12}>
                    <PreviewCard.Popup className={cn(popupClassName, "w-72 p-3")}>
                        <UsageCard harness={harness} provider={provider} signedOutHint={signedOutHint} />
                    </PreviewCard.Popup>
                </PreviewCard.Positioner>
            </PreviewCard.Portal>
        </PreviewCard.Root>
    );
}
