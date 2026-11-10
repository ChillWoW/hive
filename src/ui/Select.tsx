import type { CSSProperties, ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Select as BaseSelect } from "@base-ui/react/select";
import { CaretUpDownIcon, CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { usePortalContainer } from "./PortalContainer";

export interface SelectOption<T extends string = string> {
    value: T;
    /** Shown in the list and, when selected, in the trigger. Defaults to `value`. */
    label?: ReactNode;
    /** Drawn before the label, e.g. a swatch. */
    icon?: ReactNode;
    /** Applied to the label, e.g. to render a font name in its own face. */
    labelStyle?: CSSProperties;
}

export interface SelectProps<T extends string> {
    value: T;
    onValueChange: (value: T) => void;
    options: readonly SelectOption<T>[];
    "aria-label"?: string;
    disabled?: boolean;
    /** Classes for the trigger; it fills its container's width by default. */
    className?: string;
    /** Adds a search box to the top of the list; it matches option values. */
    searchable?: boolean;
    searchPlaceholder?: string;
    /** Shown when the search matches nothing (or there are no options). */
    emptyText?: ReactNode;
}

const triggerClassName = cn(
    "flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-sm",
    "border border-border bg-raised text-text outline-none",
    "transition-[border-color] hover:border-muted/60 focus-visible:border-muted/60",
    "data-[popup-open]:border-muted/60",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

const popupClassName = cn(
    "pointer-events-auto w-[var(--anchor-width)] min-w-56 outline-none",
    "max-h-[min(22rem,var(--available-height))]",
    "rounded-md border border-border bg-surface text-text shadow-lg shadow-black/40",
    "[transform-origin:var(--transform-origin)]",
    "transition-[opacity,scale] duration-150 ease-out",
    "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
    "data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
);

const listClassName = "scroll-py-1 overflow-y-auto overscroll-contain p-1";

const itemClassName = cn(
    "flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-2 pl-2 text-[13px] outline-none select-none",
    "data-[highlighted]:bg-hover",
    // Rows far off screen skip layout, so long lists (fonts) stay cheap.
    "[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]"
);

const checkIcon = <CheckIcon weight="bold" className="size-3" />;

/** A dropdown for one choice out of a list, each option with an optional icon. */
export function Select<T extends string>(props: SelectProps<T>) {
    return props.searchable ? <SearchableSelect {...props} /> : <PlainSelect {...props} />;
}

function TriggerContent<T extends string>({
    option,
    value,
    valueSlot
}: {
    option: SelectOption<T> | undefined;
    value: T;
    valueSlot: (children: ReactNode, style: CSSProperties | undefined) => ReactNode;
}) {
    return (
        <>
            <span className="flex min-w-0 items-center gap-2">
                {option?.icon}
                {valueSlot(option?.label ?? value, option?.labelStyle)}
            </span>
            <CaretUpDownIcon className="size-3.5 shrink-0 text-muted" />
        </>
    );
}

function PlainSelect<T extends string>({
    value,
    onValueChange,
    options,
    "aria-label": ariaLabel,
    disabled,
    className
}: SelectProps<T>) {
    const portalContainer = usePortalContainer();
    const current = options.find((o) => o.value === value);

    return (
        <BaseSelect.Root
            value={value}
            onValueChange={(next) => {
                if (next !== null) onValueChange(next as T);
            }}
            disabled={disabled}
        >
            <BaseSelect.Trigger aria-label={ariaLabel} className={cn(triggerClassName, className)}>
                <TriggerContent
                    option={current}
                    value={value}
                    valueSlot={(children, style) => (
                        <BaseSelect.Value className="min-w-0 truncate" style={style}>
                            {children}
                        </BaseSelect.Value>
                    )}
                />
            </BaseSelect.Trigger>

            <BaseSelect.Portal container={portalContainer ?? undefined}>
                <BaseSelect.Positioner
                    align="end"
                    sideOffset={6}
                    alignItemWithTrigger={false}
                    className="z-50 outline-none"
                >
                    <BaseSelect.Popup aria-label={ariaLabel} className={cn(popupClassName, listClassName)}>
                        {options.map((option) => (
                            <BaseSelect.Item key={option.value} value={option.value} className={itemClassName}>
                                {option.icon}
                                <BaseSelect.ItemText className="min-w-0 flex-1 truncate" style={option.labelStyle}>
                                    {option.label ?? option.value}
                                </BaseSelect.ItemText>
                                <BaseSelect.ItemIndicator className="shrink-0 text-accent">
                                    {checkIcon}
                                </BaseSelect.ItemIndicator>
                            </BaseSelect.Item>
                        ))}
                    </BaseSelect.Popup>
                </BaseSelect.Positioner>
            </BaseSelect.Portal>
        </BaseSelect.Root>
    );
}

function SearchableSelect<T extends string>({
    value,
    onValueChange,
    options,
    "aria-label": ariaLabel,
    disabled,
    className,
    searchPlaceholder = "Search…",
    emptyText = "No matches"
}: SelectProps<T>) {
    const portalContainer = usePortalContainer();
    const byValue = new Map(options.map((o) => [o.value, o]));

    return (
        <Combobox.Root
            items={options.map((o) => o.value)}
            value={value}
            onValueChange={(next) => {
                if (typeof next === "string") onValueChange(next as T);
            }}
            disabled={disabled}
            autoHighlight
        >
            <Combobox.Trigger aria-label={ariaLabel} className={cn(triggerClassName, className)}>
                <TriggerContent
                    option={byValue.get(value)}
                    value={value}
                    valueSlot={(children, style) => (
                        <span className="min-w-0 truncate" style={style}>
                            {children}
                        </span>
                    )}
                />
            </Combobox.Trigger>

            <Combobox.Portal container={portalContainer ?? undefined}>
                <Combobox.Positioner align="end" sideOffset={6} className="z-50 outline-none">
                    <Combobox.Popup aria-label={ariaLabel} className={cn(popupClassName, "flex flex-col overflow-hidden")}>
                        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5">
                            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted" />
                            <Combobox.Input
                                placeholder={searchPlaceholder}
                                className="h-8 min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
                            />
                        </div>
                        <Combobox.Empty className="px-3 py-4 text-center text-xs text-muted empty:hidden">
                            {emptyText}
                        </Combobox.Empty>
                        <Combobox.List className={cn("min-h-0 flex-1 empty:hidden", listClassName)}>
                            {(itemValue: T) => {
                                const option = byValue.get(itemValue);
                                return (
                                    <Combobox.Item key={itemValue} value={itemValue} className={itemClassName}>
                                        {option?.icon}
                                        <span className="min-w-0 flex-1 truncate" style={option?.labelStyle}>
                                            {option?.label ?? itemValue}
                                        </span>
                                        <Combobox.ItemIndicator className="shrink-0 text-accent">
                                            {checkIcon}
                                        </Combobox.ItemIndicator>
                                    </Combobox.Item>
                                );
                            }}
                        </Combobox.List>
                    </Combobox.Popup>
                </Combobox.Positioner>
            </Combobox.Portal>
        </Combobox.Root>
    );
}
