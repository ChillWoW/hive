import { UsageCard } from "@/chat/UsageRing";
import { useCatalogs } from "@/harnesses";
import type { HarnessId } from "@/proto";
import { useProviderUsage } from "@/providers";
import { HARNESS_ORDER } from "./summary";

/** Harnesses that report plan limits (Claude's `/usage`, Codex's rate limits). */
const WITH_LIMITS: HarnessId[] = ["claude-code", "codex"];

/**
 * The plan windows of every enabled harness that has them, as the
 * composer's usage ring shows them: a card each with its meters and resets.
 */
export function Limits() {
    const enabled = useCatalogs().map((c) => c.id);
    const harnesses = HARNESS_ORDER.filter((h) => WITH_LIMITS.includes(h) && enabled.includes(h));
    if (!harnesses.length) {
        return (
            <p className="py-16 text-center text-xs text-dark-300">
                None of the enabled agents report plan limits.
            </p>
        );
    }
    return (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
            {harnesses.map((h) => (
                <LimitsCard key={h} harness={h} />
            ))}
        </div>
    );
}

function LimitsCard({ harness }: { harness: HarnessId }) {
    const entry = useProviderUsage(harness);
    return (
        <div className="self-start overflow-hidden rounded-md border border-dark-700 bg-dark-800">
            <UsageCard harness={harness} entry={entry} />
            {entry.usage === null && !entry.error && (
                <p className="border-t border-dark-700 px-3 py-2.5 text-[11px] text-dark-300">
                    No plan limits for this login (API key or signed out).
                </p>
            )}
        </div>
    );
}
