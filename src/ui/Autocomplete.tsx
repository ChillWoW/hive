import { createContext, use, type ReactNode } from "react";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { CaretUpDownIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

function withBase<State>(base: string, className: ClassName<State>) {
    return (state: State) => cn(base, typeof className === "function" ? className(state) : className);
}

// Heights match Input and Button sizes (28-44). The trailing buttons are pulled toward
// the border so their inset roughly matches the vertical one, like Input.Group.
const inputSizes = {
    xs: "h-7 gap-1.5 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 [&_button]:size-5 [&>[data-slot=autocomplete-actions]]:-mr-1.5",
    sm: "h-8 gap-2 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5 [&_button]:size-6 [&>[data-slot=autocomplete-actions]]:-mr-2",
    md: "h-9 gap-2 px-3 text-[13px] [&_svg:not([class*='size-'])]:size-4 [&_button]:size-7 [&>[data-slot=autocomplete-actions]]:-mr-2.5",
    lg: "h-10 gap-2 px-3.5 text-sm [&_svg:not([class*='size-'])]:size-4.5 [&_button]:size-7 [&>[data-slot=autocomplete-actions]]:-mr-2.5",
    xl: "h-11 gap-2.5 px-4 text-base [&_svg:not([class*='size-'])]:size-5 [&_button]:size-8 [&>[data-slot=autocomplete-actions]]:-mr-3",
} as const;

export type AutocompleteSize = keyof typeof inputSizes;

// The input's size also scales the items, so popup text matches the input text.
const SizeContext = createContext<AutocompleteSize>("sm");

const itemSizes = {
    xs: "py-1 text-xs",
    sm: "py-1.5 text-xs",
    md: "py-1.5 text-[13px]",
    lg: "py-2 text-sm",
    xl: "py-2 text-base",
} as const;

export type AutocompleteProps<ItemValue> = AutocompletePrimitive.Root.Props<ItemValue> & {
    /** Size of the input and items. */
    size?: AutocompleteSize;
};

/**
 * A text input that suggests matching items as you type. The value is the free-form
 * input text; picking an item fills it in. Compose with `Autocomplete.Input` and
 * `Autocomplete.Content` (rendering an `Autocomplete.Item` per item). Pass `items` so
 * the list filters itself. Use `Select` instead when the value must be one of the items.
 * Label it with `Field.Label` or `aria-label` on the input.
 */
export function Autocomplete<ItemValue>({ size = "sm", ...props }: AutocompleteProps<ItemValue>) {
    return (
        <SizeContext value={size}>
            <AutocompletePrimitive.Root {...(props as AutocompletePrimitive.Root.Props<unknown>)} />
        </SizeContext>
    );
}

export interface AutocompleteInputProps extends Omit<AutocompletePrimitive.Input.Props, "size" | "className"> {
    /** Applied to the bordered wrapper, which also anchors the popup. */
    className?: string;
    /** Leading icon or text, e.g. a search icon. */
    icon?: ReactNode;
    /** Show a clear button while the input has text. Defaults to `true`. */
    showClear?: boolean;
    /** Show a caret button that opens the popup with all items. */
    showTrigger?: boolean;
}

/** The bordered text input. Other props (`placeholder`, `aria-label`, ...) go to the `<input>`. */
function AutocompleteInput({
    className,
    icon,
    showClear = true,
    showTrigger = false,
    ...props
}: AutocompleteInputProps) {
    const size = use(SizeContext);
    return (
        <AutocompletePrimitive.InputGroup
            data-slot="autocomplete-input"
            className={cn(
                "flex w-full min-w-0 cursor-text items-center rounded-md border border-border text-text transition-[border-color] duration-150 ease-out",
                "has-[input:focus-visible]:border-muted data-popup-open:border-muted",
                "has-[input[aria-invalid=true]]:border-danger data-invalid:border-danger",
                "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                "data-readonly:[&>[data-slot=autocomplete-actions]]:hidden",
                "[&_svg]:pointer-events-none [&_svg]:shrink-0",
                inputSizes[size],
                className,
            )}
        >
            {icon && <span className="flex shrink-0 select-none items-center text-muted">{icon}</span>}
            <AutocompletePrimitive.Input
                className="h-full min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-muted selection:bg-accent selection:text-accent-fg disabled:cursor-not-allowed"
                {...props}
            />
            <div data-slot="autocomplete-actions" className="flex shrink-0 items-center empty:hidden">
                {showClear && (
                    <AutocompletePrimitive.Clear
                        aria-label="Clear"
                        className={cn(actionButton, "data-starting-style:opacity-0 data-ending-style:opacity-0")}
                    >
                        <XIcon />
                    </AutocompletePrimitive.Clear>
                )}
                {showTrigger && (
                    <AutocompletePrimitive.Trigger aria-label="Show suggestions" className={actionButton}>
                        <CaretUpDownIcon />
                    </AutocompletePrimitive.Trigger>
                )}
            </div>
        </AutocompletePrimitive.InputGroup>
    );
}

const actionButton = cn(
    "flex cursor-default items-center justify-center rounded-sm text-muted outline-none transition-[color,background-color,opacity] duration-150 ease-out",
    "hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:text-text",
    "data-disabled:pointer-events-none",
);

export interface AutocompleteContentProps
    extends Omit<AutocompletePrimitive.Popup.Props, "children">,
        Pick<
            AutocompletePrimitive.Positioner.Props,
            "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
        > {
    /** Where to portal the popup. Defaults to `document.body`. */
    container?: AutocompletePrimitive.Portal.Props["container"];
    /** Shown when nothing matches. Without it, the popup hides instead. */
    empty?: ReactNode;
    /** Items, or a function rendering each (filtered) item from the root's `items`. */
    children?: AutocompletePrimitive.List.Props["children"];
}

/** The popup with the suggestion list. Opens below the input, matching its width. */
function AutocompleteContent({
    side,
    align = "start",
    sideOffset = 4,
    alignOffset,
    collisionPadding = 8,
    container,
    empty,
    className,
    children,
    ...props
}: AutocompleteContentProps) {
    return (
        <AutocompletePrimitive.Portal container={container}>
            <AutocompletePrimitive.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset}
                alignOffset={alignOffset}
                collisionPadding={collisionPadding}
                className={cn("outline-none select-none", empty == null && "data-empty:hidden")}
            >
                <AutocompletePrimitive.Popup
                    className={withBase(
                        cn(
                            "flex max-h-[min(20rem,var(--available-height))] w-(--anchor-width) max-w-(--available-width) flex-col overflow-hidden rounded-md border border-border bg-raised text-text shadow-lg shadow-shadow/40 outline-none",
                            "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out",
                            "data-starting-style:scale-95 data-starting-style:opacity-0",
                            "data-ending-style:scale-95 data-ending-style:opacity-0",
                        ),
                        className,
                    )}
                    {...props}
                >
                    {/* Stays mounted so screen readers announce the empty state. */}
                    <AutocompletePrimitive.Empty className="empty:hidden px-3 py-2 text-xs text-muted">
                        {empty}
                    </AutocompletePrimitive.Empty>
                    <AutocompletePrimitive.List className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:hidden">
                        {children}
                    </AutocompletePrimitive.List>
                </AutocompletePrimitive.Popup>
            </AutocompletePrimitive.Positioner>
        </AutocompletePrimitive.Portal>
    );
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
    const size = use(SizeContext);
    return (
        <AutocompletePrimitive.Item
            className={withBase(
                cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 text-text outline-none select-none",
                    "data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-50",
                    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted",
                    itemSizes[size],
                ),
                className,
            )}
            {...props}
        />
    );
}

/** Heading for a group. Must be inside `Autocomplete.Group`. */
function AutocompleteLabel({ className, ...props }: AutocompletePrimitive.GroupLabel.Props) {
    return (
        <AutocompletePrimitive.GroupLabel
            className={withBase("px-2.5 py-1 text-[11px] font-medium text-muted select-none", className)}
            {...props}
        />
    );
}

function AutocompleteSeparator({ className, ...props }: AutocompletePrimitive.Separator.Props) {
    return (
        <AutocompletePrimitive.Separator className={withBase("-mx-1 my-1 h-px bg-border", className)} {...props} />
    );
}

Autocomplete.Input = AutocompleteInput;
Autocomplete.Content = AutocompleteContent;
Autocomplete.Item = AutocompleteItem;
/** With grouped `items`, pass the group's `items` and render them via `Autocomplete.Collection`. */
Autocomplete.Group = AutocompletePrimitive.Group;
Autocomplete.Label = AutocompleteLabel;
Autocomplete.Collection = AutocompletePrimitive.Collection;
Autocomplete.Separator = AutocompleteSeparator;
