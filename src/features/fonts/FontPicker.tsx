import { useEffect } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CaretUpDownIcon, CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { cssFontFamily, fontChoices, useFontsStore } from "./store";

const fontStyle = (name: string) => ({ fontFamily: `${cssFontFamily(name)}, var(--font-sans)` });

/**
 * The bundled font and every installed family, each shown in its own face.
 * Styled like `Select`, with a search on top: there can be hundreds.
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

    useEffect(() => {
        void load();
    }, [load]);

    const choices = fontChoices(installed ?? [], value);

    return (
        <Combobox.Root
            items={choices}
            value={value}
            onValueChange={(next) => {
                if (typeof next === "string") onChange(next);
            }}
            autoHighlight
        >
            <Combobox.Trigger
                aria-label="Interface font"
                className={cn(
                    "flex h-8 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-transparent pr-2 pl-2.5 text-left text-sm text-text outline-none select-none",
                    "transition-[border-color] duration-150 ease-out focus-visible:border-muted data-popup-open:border-muted",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50"
                )}
            >
                <span className="min-w-0 flex-1 truncate" style={fontStyle(value)}>
                    {value}
                </span>
                <CaretUpDownIcon className="size-4 shrink-0 text-muted" />
            </Combobox.Trigger>

            <Combobox.Portal>
                <Combobox.Positioner align="start" sideOffset={4} collisionPadding={8} className="outline-none">
                    <Combobox.Popup
                        aria-label="Interface font"
                        className={cn(
                            "flex max-h-[min(22rem,var(--available-height))] w-(--anchor-width) min-w-56 flex-col overflow-hidden rounded-md border border-border bg-raised text-text shadow-lg shadow-shadow/40 outline-none",
                            "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out",
                            "data-starting-style:scale-95 data-starting-style:opacity-0",
                            "data-ending-style:scale-95 data-ending-style:opacity-0"
                        )}
                    >
                        <label className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2.5">
                            <MagnifyingGlassIcon className="size-4 shrink-0 text-muted" />
                            <Combobox.Input
                                placeholder="Search fonts…"
                                className="h-full min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
                            />
                        </label>
                        <Combobox.Empty className="px-3 py-2 text-sm text-muted empty:hidden">
                            {installed === null ? "Loading fonts…" : "No fonts found"}
                        </Combobox.Empty>
                        <Combobox.List className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 empty:hidden">
                            {(name: string) => (
                                <Combobox.Item
                                    key={name}
                                    value={name}
                                    className={cn(
                                        "relative flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm text-text outline-none select-none",
                                        "data-highlighted:bg-hover",
                                        // Rows far off screen skip layout, so hundreds of fonts stay cheap.
                                        "[contain-intrinsic-size:auto_2rem] [content-visibility:auto]"
                                    )}
                                >
                                    <span className="min-w-0 flex-1 truncate" style={fontStyle(name)}>
                                        {name}
                                    </span>
                                    <Combobox.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
                                        <CheckIcon weight="bold" className="size-3.5" />
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
