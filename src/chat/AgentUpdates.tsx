import { useEffect, useRef, useState } from "react";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { HarnessIcon, useCatalogs } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { HarnessCatalog, HarnessId } from "@/proto";
import {
    availableUpdate,
    providers,
    refreshProvider,
    useProvidersStore,
    type ProviderEntry
} from "@/providers";
import { Button, MorphHeight } from "@/ui";

/** Probes run the CLIs and the release check hits npm; at most this often. */
const STALE_MS = 10 * 60 * 1000;

type Update = { catalog: HarnessCatalog; entry: ProviderEntry; latest: string };

/**
 * The new-chat view's "2 agent updates" pill, as in zeron: the enabled
 * agents whose CLI has a newer release. Click opens it in place into a card
 * with an Update button per agent; hidden while there's nothing to update.
 */
export function AgentUpdates() {
    const catalogs = useCatalogs();
    const entries = useProvidersStore((s) => s.entries);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const ids = catalogs.map((c) => c.id).join(",");
    useEffect(() => {
        const check = () => {
            for (const id of ids.split(",").filter(Boolean)) {
                void refreshProvider(id as HarnessId, { maxAge: STALE_MS });
            }
        };
        check();
        window.addEventListener("focus", check);
        return () => window.removeEventListener("focus", check);
    }, [ids]);

    const updates: Update[] = catalogs.flatMap((catalog) => {
        const entry = entries[catalog.id];
        const latest = entry?.status?.canUpdate ? availableUpdate(entry) : undefined;
        return entry && latest ? [{ catalog, entry, latest }] : [];
    });
    const count = updates.length;

    useEffect(() => {
        if (count === 0) setOpen(false);
    }, [count]);

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
                    "pointer-events-auto max-w-full overflow-hidden rounded-[18px] border border-dark-700 bg-dark-850 shadow-lg shadow-black/30",
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
                                className="flex h-10 w-full items-center gap-2 px-4 text-left text-[13px] font-medium text-dark-50 outline-none hover:bg-dark-800 focus-visible:bg-dark-800"
                            >
                                <span className="min-w-0 flex-1 truncate">{title}</span>
                                <CaretDownIcon weight="bold" className="size-3 text-dark-200" />
                            </button>
                            <div className="border-t border-dark-700 px-4">
                                {updates.map((update) => (
                                    <UpdateRow key={update.catalog.id} {...update} />
                                ))}
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            aria-expanded={false}
                            onClick={() => setOpen(true)}
                            className="flex h-9 items-center gap-2.5 pr-3.5 pl-2 text-[13px] font-medium whitespace-nowrap text-dark-50 outline-none hover:bg-dark-800 focus-visible:bg-dark-800"
                        >
                            <span className="flex items-center">
                                {updates.slice(0, 3).map(({ catalog }, i) => (
                                    <span
                                        key={catalog.id}
                                        className={cn(
                                            "grid size-6 place-items-center rounded-full bg-dark-700 ring-2 ring-dark-850",
                                            i > 0 && "-ml-2"
                                        )}
                                    >
                                        <HarnessIcon harness={catalog.id} className="size-3" />
                                    </span>
                                ))}
                            </span>
                            {title}
                            <CaretUpIcon weight="bold" className="size-3 text-dark-200" />
                        </button>
                    )}
                </MorphHeight>
            </div>
        </div>
    );
}

function UpdateRow({ catalog, entry, latest }: Update) {
    const updating = entry.action === "updating";
    return (
        <div className="flex flex-col gap-1 py-3 not-first:border-t not-first:border-dark-700">
            <div className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-dark-700">
                    <HarnessIcon harness={catalog.id} className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] leading-5 font-medium text-dark-50">
                        {catalog.label}
                    </div>
                    <div className="truncate text-xs text-dark-250 tabular-nums">
                        {entry.status?.version} → {latest}
                    </div>
                </div>
                <Button
                    size="sm"
                    variant="primary"
                    loading={updating}
                    disabled={!!entry.action && !updating}
                    onClick={() => void providers.update(catalog.id)}
                    className="rounded-full px-3"
                >
                    {updating ? "Updating" : "Update"}
                </Button>
            </div>
            {entry.error && (
                <p className="line-clamp-2 pl-11 text-[11px] text-danger">{entry.error}</p>
            )}
        </div>
    );
}
