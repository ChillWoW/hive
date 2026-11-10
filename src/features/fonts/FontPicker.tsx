import { useEffect } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CaretUpDownIcon, CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { usePortalContainer } from "@/ui/PortalContainer";
import { cssFontFamily, fontChoices, useFontsStore } from "./store";

/**
 * A searchable list of the bundled font and every installed family, each
 * shown in its own face.
 */
export function FontPicker({
    value,
    onChange
}: {
    value: string;
    onChange: (name: string) => void;
}) {
    const installed = useFontsStore((s) => s.installed);
    const load = useFontsStore((s) => s.load);
    const portalContainer = usePortalContainer();

    useEffect(() => {
        void load();
    }, [load]);

    const items = fontChoices(installed ?? [], value);

    return (
        <Combobox.Root
            items={items}
            value={value}
            onValueChange={(next) => {
                if (typeof next === "string") onChange(next);
            }}
            autoHighlight
        >
            <Combobox.Trigger
                aria-label="Interface font"
                className={cn(
                    "flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-sm",
                    "border border-border bg-raised text-text outline-none",
                    "transition-[border-color] hover:border-muted/60 focus-visible:border-muted/60",
                    "data-[popup-open]:border-muted/60"
                )}
            >
                <span className="min-w-0 truncate" style={{ fontFamily: `${cssFontFamily(value)}, var(--font-sans)` }}>
                    {value}
                </span>
                <CaretUpDownIcon className="size-3.5 shrink-0 text-muted" />
            </Combobox.Trigger>

            <Combobox.Portal container={portalContainer ?? undefined}>
                <Combobox.Positioner align="end" sideOffset={6} className="z-50 outline-none">
                    <Combobox.Popup
                        aria-label="Interface font"
                        className={cn(
                            "pointer-events-auto flex w-64 flex-col overflow-hidden outline-none",
                            "max-h-[min(22rem,var(--available-height))]",
                            "rounded-md border border-border bg-surface text-text shadow-lg shadow-black/40",
                            "[transform-origin:var(--transform-origin)]",
                            "transition-[opacity,scale] duration-150 ease-out",
                            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
                        )}
                    >
                        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5">
                            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted" />
                            <Combobox.Input
                                placeholder="Search fonts…"
                                className="h-8 min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
                            />
                        </div>
                        <Combobox.Empty className="px-3 py-4 text-center text-xs text-muted empty:hidden">
                            {installed === null ? "Loading fonts…" : "No fonts found"}
                        </Combobox.Empty>
                        <Combobox.List className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 empty:hidden">
                            {(name: string) => (
                                <Combobox.Item
                                    key={name}
                                    value={name}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-2.5 text-[13px] outline-none select-none",
                                        "data-[highlighted]:bg-hover",
                                        // Rows far off screen skip layout, so hundreds of faces don't all load at once.
                                        "[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]"
                                    )}
                                >
                                    <span
                                        className="min-w-0 flex-1 truncate"
                                        style={{ fontFamily: `${cssFontFamily(name)}, var(--font-sans)` }}
                                    >
                                        {name}
                                    </span>
                                    <Combobox.ItemIndicator className="shrink-0 text-accent">
                                        <CheckIcon weight="bold" className="size-3" />
                                    </Combobox.ItemIndicator>
                                </Combobox.Item>
                            )}
                        </Combobox.List>
                    </Combobox.Popup>
                </Combobox.Positioner>
            </Combobox.Portal>
        </Combobox.Root>
    );
}
