import { useEffect, useRef, useState } from "react";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import type { HarnessId } from "@/proto";
import { antigravity } from "@/features/antigravity/store";
import { claude } from "@/features/claude/store";
import { codex } from "@/features/codex/store";
import { HarnessMark } from "@/features/models";
import { availableUpdate, type Provider } from "@/features/providers/makeProvider";
import { cn } from "@/lib/cn";
import { onWindowFocus } from "@/lib/windowFocus";
import { Button, MorphHeight } from "@/ui";

const AGENTS: { harness: HarnessId; provider: Provider }[] = [
    { harness: "claude", provider: claude },
    { harness: "codex", provider: codex },
    { harness: "antigravity", provider: antigravity }
];

/** Probes run the CLIs and the release check hits npm; at most this often. */
const STALE_MS = 10 * 60_000;

type Update = { harness: HarnessId; provider: Provider; version: string; latest: string };

/**
 * The new-chat view's "2 agent updates" pill: the agents whose CLI has a
 * newer release. Click opens it in place into a card with an Update button
 * per agent; hidden while there's nothing to update.
 */
export function AgentUpdates() {
    const claudeState = claude.useProvider();
    const codexState = codex.useProvider();
    const antigravityState = antigravity.useProvider();
    const states = { claude: claudeState, codex: codexState, antigravity: antigravityState };
    const [expanded, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const check = () => AGENTS.forEach(({ provider }) => void provider.refreshIfStale(STALE_MS));
        check();
        return onWindowFocus(check);
    }, []);

    const updates: Update[] = AGENTS.flatMap(({ harness, provider }) => {
        const state = states[harness as keyof typeof states];
        const latest = availableUpdate(state);
        const version = state.status?.version;
        return latest && version ? [{ harness, provider, version, latest }] : [];
    });
    const count = updates.length;
    const open = expanded && count > 0;

    // A click anywhere else folds it back.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [open]);

    if (count === 0) return null;

    const title = `${count} agent ${count === 1 ? "update" : "updates"}`;

    return (
        <div
            ref={rootRef}
            onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                    event.preventDefault();
                    setOpen(false);
                }
            }}
            className="pointer-events-none absolute inset-x-4 bottom-4 z-10 flex justify-center"
        >
            <div
                className={cn(
                    "pointer-events-auto max-w-full overflow-hidden rounded-[18px] border border-border bg-surface shadow-lg shadow-shadow/30",
                    // Width eases between the pill's own and the card's where
                    // the webview can interpolate `auto` (Chromium); else it jumps.
                    "[interpolate-size:allow-keywords] transition-[width] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    open ? "w-[340px]" : "w-auto"
                )}
            >
                <MorphHeight swapKey={open ? "card" : "pill"}>
                    {open ? (
                        <div className="flex flex-col">
                            <button
                                type="button"
                                aria-expanded
                                onClick={() => setOpen(false)}
                                className="flex h-10 w-full cursor-pointer items-center gap-2 px-4 text-left text-[13px] font-medium text-text outline-none hover:bg-raised focus-visible:bg-raised"
                            >
                                <span className="min-w-0 flex-1 truncate">{title}</span>
                                <CaretDownIcon weight="bold" className="size-3 text-muted" />
                            </button>
                            <div className="border-t border-border px-4">
                                {updates.map((update) => (
                                    <UpdateRow key={update.harness} {...update} />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            aria-expanded={false}
                            onClick={() => setOpen(true)}
                            className="flex h-9 cursor-pointer items-center gap-2.5 pr-3.5 pl-2 text-[13px] font-medium whitespace-nowrap text-text outline-none hover:bg-raised focus-visible:bg-raised"
                        >
                            <span className="flex items-center">
                                {updates.slice(0, 3).map(({ harness }, i) => (
                                    <span
                                        key={harness}
                                        className={cn(
                                            "grid size-6 place-items-center rounded-full bg-hover ring-2 ring-surface",
                                            i > 0 && "-ml-2"
                                        )}
                                    >
                                        <HarnessMark harness={harness} className="size-3" />
                                    </span>
                                ))}
                            </span>
                            {title}
                            <CaretUpIcon weight="bold" className="size-3 text-muted" />
                        </button>
                    )}
                </MorphHeight>
            </div>
        </div>
    );
}

function UpdateRow({ harness, provider, version, latest }: Update) {
    const action = provider.useProvider((s) => s.action);
    const updating = action === "updating";
    return (
        <div className="flex items-center gap-3 py-3 not-first:border-t not-first:border-border">
            <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-hover">
                <HarnessMark harness={harness} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] leading-5 font-medium text-text">{provider.name}</div>
                <div className="truncate text-xs text-muted tabular-nums">
                    {version} → {latest}
                </div>
            </div>
            <Button
                size="sm"
                loading={updating}
                disabled={!!action && !updating}
                onClick={() => void provider.actions.update()}
                className="rounded-full px-3"
            >
                {updating ? "Updating" : "Update"}
            </Button>
        </div>
    );
}
