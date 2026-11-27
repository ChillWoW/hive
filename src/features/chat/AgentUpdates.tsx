import { useEffect, useRef, useState, type ComponentProps } from "react";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import type { HarnessId } from "@/proto";
import { antigravity } from "@/features/antigravity/store";
import { claude } from "@/features/claude/store";
import { codex } from "@/features/codex/store";
import { HarnessMark } from "@/features/models";
import { availableUpdate, type Provider } from "@/features/providers/makeProvider";
import { cn } from "@/lib/cn";
import { onWindowFocus } from "@/lib/windowFocus";
import { MorphHeight, Spinner } from "@/ui";

const AGENTS: { harness: HarnessId; provider: Provider }[] = [
    { harness: "claude", provider: claude },
    { harness: "codex", provider: codex },
    { harness: "antigravity", provider: antigravity }
];

/** Probes run the CLIs and the release check hits npm; at most this often. */
const STALE_MS = 10 * 60_000;

type Update = { harness: HarnessId; provider: Provider; version: string; latest: string };

/**
 * The new-chat view's agent update notice: one muted line under the
 * composer naming the agents whose CLI has a newer release. Click opens it
 * in place into a line per agent with its versions and an Update link;
 * hidden while there's nothing to update.
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

    const summary =
        count === 1
            ? `${updates[0].provider.name} ${updates[0].latest} is available`
            : count === 2
              ? `${updates[0].provider.name} and ${updates[1].provider.name} have updates`
              : `${count} agents have updates`;

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
            <MorphHeight swapKey={open ? "list" : "line"} className="pointer-events-auto max-w-full">
                {open ? (
                    <div className="grid grid-cols-[14px_max-content_max-content_auto] items-center justify-center gap-x-3">
                        {updates.map((update) => (
                            <UpdateRow key={update.harness} {...update} />
                        ))}
                        <Line
                            aria-expanded
                            onClick={() => setOpen(false)}
                            className="col-span-full mt-1.5 justify-self-center"
                        >
                            Hide
                            <CaretDownIcon weight="bold" className="size-3" />
                        </Line>
                    </div>
                ) : (
                    <Line aria-expanded={false} onClick={() => setOpen(true)}>
                        <span className="flex shrink-0 items-center gap-1">
                            {updates.map(({ harness }) => (
                                <HarnessMark key={harness} harness={harness} className="size-[13px]" />
                            ))}
                        </span>
                        <span className="truncate">{summary}</span>
                        <CaretUpIcon weight="bold" className="size-3 shrink-0" />
                    </Line>
                )}
            </MorphHeight>
        </div>
    );
}

/** The muted, surface-less text button the notice is made of. */
function Line({ className, ...props }: ComponentProps<"button">) {
    return (
        <button
            type="button"
            className={cn(
                "flex h-7 max-w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-[12.5px] whitespace-nowrap text-muted outline-none transition-colors hover:text-text focus-visible:text-text focus-visible:outline-2 focus-visible:outline-accent",
                className
            )}
            {...props}
        />
    );
}

function UpdateRow({ harness, provider, version, latest }: Update) {
    const action = provider.useProvider((s) => s.action);
    const updating = action === "updating";
    return (
        <div className="col-span-full grid h-7.5 grid-cols-subgrid items-center text-[13px]">
            <HarnessMark harness={harness} className="size-3.5" />
            <span className="font-medium text-text">{provider.name}</span>
            <span className="text-xs text-muted tabular-nums">
                {version} → <span className="text-text">{latest}</span>
            </span>
            {updating ? (
                <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                    <Spinner label="Updating" className="size-3.5" />
                    Updating
                </span>
            ) : (
                <button
                    type="button"
                    disabled={!!action}
                    onClick={() => void provider.actions.update()}
                    className="cursor-pointer justify-self-start rounded-sm text-[12.5px] text-text underline decoration-muted/55 underline-offset-3 outline-none hover:decoration-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"
                >
                    Update
                </button>
            )}
        </div>
    );
}
