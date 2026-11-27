import { XIcon } from "@phosphor-icons/react";
import { create } from "zustand";
import type { ChatConfig, HarnessId, Model, UsageWindow } from "@/proto";
import { antigravity } from "@/features/antigravity/store";
import { claude } from "@/features/claude/store";
import { resetsIn, tightestWindow, TONE_TEXT, usageTone } from "@/features/claude/usage";
import { codex } from "@/features/codex/store";
import { harnessOf, resolveModel, useCatalog } from "@/features/models";
import type { Provider } from "@/features/providers/makeProvider";
import { settings } from "@/features/settings";
import { cn } from "@/lib/cn";
import { useMinuteClock } from "@/lib/time";
import { IconButton, Ring } from "@/ui";

const PROVIDERS: Record<HarnessId, Provider> = { claude, codex, antigravity };

/** How much of a window is used before the composer says so. */
const WARN_AT = 0.8;

type Level = "close" | "closer" | "reached";

const level = (used: number): Level => (used >= 1 ? "reached" : usageTone(used) === "danger" ? "closer" : "close");

/** Warnings closed with ✕, by window: gone until it resets or gets a level worse. */
const useDismissed = create<Record<string, true>>()(() => ({}));

/**
 * Whether a window counts against `model`. One for the whole plan ("Week")
 * always does; one for some models ("Week · Opus", "5 hours · Claude & GPT")
 * does when the model's name has every word of one of its names.
 */
function appliesTo(window: UsageWindow, model: Model | undefined): boolean {
    const scope = window.label.split(" · ")[1];
    if (!scope) return true;
    if (!model) return false;
    const name = `${model.id} ${model.label}`.toLowerCase();
    return scope.split("&").some((part) => {
        const words = part.toLowerCase().match(/[a-z]+/g) ?? [];
        return words.length > 0 && words.every((word) => name.includes(word));
    });
}

/**
 * A line above the composer once the plan the chat's model runs on is close
 * to a usage limit: which window, how full, and when it resets. Amber from
 * 80%, red past 90%. A click opens Settings › Providers; ✕ closes it until
 * the window resets or gets worse.
 */
export function UsageWarning({ config }: { config: ChatConfig }) {
    const harness = harnessOf(config);
    // Keyed: each provider has its own store behind the hooks.
    return <Warning key={harness} provider={PROVIDERS[harness]} model={resolveModel(useCatalog(harness), config)} />;
}

function Warning({ provider, model }: { provider: Provider; model: Model | undefined }) {
    provider.useUsagePolling(true);
    const windows = provider.useUsage((s) => s.windows);
    const now = useMinuteClock();
    const top = tightestWindow(windows?.filter((w) => appliesTo(w, model)));
    const key = top && `${provider.name}/${top.label}/${top.resetsAt ?? ""}/${level(top.used)}`;
    const dismissed = useDismissed((s) => !!key && key in s);
    // A window past its reset is stale until the next read.
    const over = !!top?.resetsAt && Date.parse(top.resetsAt) <= now;
    if (!top || !key || top.used < WARN_AT || dismissed || over) return null;

    const reached = top.used >= 1;
    const tone = usageTone(top.used);
    const percent = Math.min(Math.floor(top.used * 100), 99);
    const reset = resetsIn(top.resetsAt, now);

    return (
        <div
            role="status"
            className={cn(
                "mb-2 flex min-h-8 items-center gap-2 rounded-xl border py-1 pr-1 pl-2.5 text-[13px]",
                "transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0",
                tone === "danger" ? "border-danger/25 bg-danger/8" : "border-warning/25 bg-warning/8"
            )}
        >
            <Ring fraction={top.used} className={TONE_TEXT[tone]} />
            <button
                type="button"
                onClick={() => settings.open("providers")}
                className="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left outline-none hover:underline focus-visible:underline"
            >
                <span className="truncate text-text">
                    {provider.name} · {top.label} limit {reached ? "reached" : `${percent}% used`}
                </span>
                {reset && <span className="shrink-0 text-xs text-muted">{reset}</span>}
            </button>
            <IconButton label="Dismiss" side="top" onClick={() => useDismissed.setState({ [key]: true })}>
                <XIcon className="size-3.5" />
            </IconButton>
        </div>
    );
}
