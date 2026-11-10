import { Select } from "@base-ui/react/select";
import { CaretUpDownIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { usePortalContainer } from "@/ui/PortalContainer";
import { allThemes, useThemesStore } from "./store";
import type { Theme } from "./themes";

/** A dropdown of every theme, built-in and user, each with a colour swatch. */
export function ThemePicker({
    value,
    onChange
}: {
    value: string;
    onChange: (name: string) => void;
}) {
    const user = useThemesStore((s) => s.user);
    const themes = allThemes(user);
    const portalContainer = usePortalContainer();
    const current = themes[value];

    return (
        <Select.Root
            value={value}
            onValueChange={(next) => {
                if (typeof next === "string") onChange(next);
            }}
        >
            <Select.Trigger
                aria-label="Theme"
                className={cn(
                    "flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-sm",
                    "border border-border bg-raised text-text outline-none",
                    "transition-[border-color] hover:border-muted/60 focus-visible:border-muted/60",
                    "data-[popup-open]:border-muted/60"
                )}
            >
                <span className="flex min-w-0 items-center gap-2">
                    {current && <Swatch theme={current} />}
                    <Select.Value className="min-w-0 truncate">{value}</Select.Value>
                </span>
                <Select.Icon className="shrink-0 text-muted">
                    <CaretUpDownIcon className="size-3.5" />
                </Select.Icon>
            </Select.Trigger>

            <Select.Portal container={portalContainer ?? undefined}>
                <Select.Positioner
                    align="end"
                    sideOffset={6}
                    alignItemWithTrigger={false}
                    className="z-50 outline-none"
                >
                    <Select.Popup
                        className={cn(
                            "pointer-events-auto w-[var(--anchor-width)] min-w-56 outline-none",
                            "max-h-[min(22rem,var(--available-height))] overflow-y-auto overscroll-contain p-1",
                            "rounded-md border border-border bg-surface text-text shadow-lg shadow-black/40",
                            "[transform-origin:var(--transform-origin)]",
                            "transition-[opacity,scale] duration-150 ease-out",
                            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
                        )}
                    >
                        {Object.entries(themes).map(([name, theme]) => (
                            <Select.Item
                                key={name}
                                value={name}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-[13px] outline-none select-none",
                                    "data-[highlighted]:bg-hover"
                                )}
                            >
                                <Swatch theme={theme} />
                                <Select.ItemText className="min-w-0 flex-1 truncate">
                                    {name}
                                    {name in user && <span className="text-muted"> · custom</span>}
                                </Select.ItemText>
                                <Select.ItemIndicator className="shrink-0 text-accent">
                                    <CheckIcon weight="bold" className="size-3" />
                                </Select.ItemIndicator>
                            </Select.Item>
                        ))}
                    </Select.Popup>
                </Select.Positioner>
            </Select.Portal>
        </Select.Root>
    );
}

/** Background, surface and accent side by side, in the theme's own colours. */
function Swatch({ theme: t }: { theme: Theme }) {
    return (
        <span
            aria-hidden
            className="flex h-3.5 w-6 shrink-0 overflow-hidden rounded-[3px] border"
            style={{ borderColor: t.border }}
        >
            <i className="block flex-1" style={{ background: t.bg }} />
            <i className="block flex-1" style={{ background: t.surface }} />
            <i className="block flex-1" style={{ background: t.accent }} />
        </span>
    );
}
