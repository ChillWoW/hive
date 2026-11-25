import { useContext, type ComponentProps, type ReactNode } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { MenuKindContext } from "./menu-kind";

type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

function withBase<State>(base: string, className: ClassName<State>) {
    return (state: State) => cn(base, typeof className === "function" ? className(state) : className);
}

const itemBase = cn(
    "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text outline-none select-none",
    "data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted",
);

const itemVariants = {
    default: "",
    destructive: "text-danger data-highlighted:bg-danger/10 [&_svg:not([class*='text-'])]:text-danger",
} as const;

export type MenuItemVariant = keyof typeof itemVariants;

/**
 * Dropdown menu opened from a trigger. Compose with `Menu.Trigger` and `Menu.Content`;
 * every part except the root and trigger is shared with `ContextMenu`.
 */
export function Menu(props: MenuPrimitive.Root.Props) {
    return (
        <MenuKindContext value="dropdown">
            <MenuPrimitive.Root {...props} />
        </MenuKindContext>
    );
}

export interface MenuContentProps
    extends MenuPrimitive.Popup.Props,
        Pick<
            MenuPrimitive.Positioner.Props,
            "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
        > {
    /** Where to portal the popup. Defaults to `document.body`. */
    container?: MenuPrimitive.Portal.Props["container"];
}

/**
 * The popup. Positioning defaults depend on where it's used: below the trigger and
 * start-aligned in a `Menu`, at the pointer in a `ContextMenu`, beside its trigger
 * (first items lined up) inside `Menu.Sub`.
 */
function MenuContent({
    side,
    align,
    sideOffset,
    alignOffset,
    collisionPadding = 8,
    container,
    className,
    ...props
}: MenuContentProps) {
    const kind = useContext(MenuKindContext);
    // Undefined lets Base UI apply its own defaults (context menus offset from the pointer).
    const defaults =
        kind === "dropdown"
            ? { align: "start" as const, sideOffset: 4 }
            : kind === "submenu"
              ? // Popup is p-1 + 1px border: overlap the parent's border and align first items.
                { sideOffset: 4, alignOffset: -5 }
              : {};

    return (
        <MenuPrimitive.Portal container={container}>
            <MenuPrimitive.Positioner
                side={side}
                align={align ?? defaults.align}
                sideOffset={sideOffset ?? defaults.sideOffset}
                alignOffset={alignOffset ?? defaults.alignOffset}
                collisionPadding={collisionPadding}
            >
                <MenuPrimitive.Popup
                    className={withBase(
                        cn(
                            "max-h-(--available-height) min-w-40 overflow-y-auto rounded-md border border-border bg-raised p-1 text-text shadow-lg shadow-black/40 outline-none",
                            "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out",
                            "data-starting-style:scale-95 data-starting-style:opacity-0",
                            "data-ending-style:scale-95 data-ending-style:opacity-0",
                        ),
                        className,
                    )}
                    {...props}
                />
            </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
    );
}

export interface MenuItemProps extends MenuPrimitive.Item.Props {
    variant?: MenuItemVariant;
    /** Indents the text to line up with checkbox/radio items. */
    inset?: boolean;
}

function MenuItem({ variant = "default", inset, className, ...props }: MenuItemProps) {
    return (
        <MenuPrimitive.Item
            className={withBase(cn(itemBase, itemVariants[variant], inset && "pl-8"), className)}
            {...props}
        />
    );
}

export interface MenuLinkItemProps extends MenuPrimitive.LinkItem.Props {
    variant?: MenuItemVariant;
    inset?: boolean;
}

/** An item that renders an `<a>`; pass `href`. */
function MenuLinkItem({ variant = "default", inset, className, ...props }: MenuLinkItemProps) {
    return (
        <MenuPrimitive.LinkItem
            className={withBase(cn(itemBase, itemVariants[variant], inset && "pl-8"), className)}
            {...props}
        />
    );
}

function ItemIndicator({ children }: { children: ReactNode }) {
    return (
        <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
            {children}
        </span>
    );
}

/** Toggle item with a check mark. Stays open on click (`closeOnClick` to change). */
function MenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
    return (
        <MenuPrimitive.CheckboxItem className={withBase(cn(itemBase, "pl-8"), className)} {...props}>
            <ItemIndicator>
                <MenuPrimitive.CheckboxItemIndicator>
                    <CheckIcon weight="bold" className="size-3.5 text-text" />
                </MenuPrimitive.CheckboxItemIndicator>
            </ItemIndicator>
            {children}
        </MenuPrimitive.CheckboxItem>
    );
}

/** Use inside `Menu.RadioGroup`. Stays open on click (`closeOnClick` to change). */
function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
    return (
        <MenuPrimitive.RadioItem className={withBase(cn(itemBase, "pl-8"), className)} {...props}>
            <ItemIndicator>
                <MenuPrimitive.RadioItemIndicator className="size-1.5 rounded-full bg-text" />
            </ItemIndicator>
            {children}
        </MenuPrimitive.RadioItem>
    );
}

export interface MenuLabelProps extends MenuPrimitive.GroupLabel.Props {
    inset?: boolean;
}

/** Heading for a group. Must be inside `Menu.Group` or `Menu.RadioGroup`. */
function MenuLabel({ inset, className, ...props }: MenuLabelProps) {
    return (
        <MenuPrimitive.GroupLabel
            className={withBase(cn("px-2 py-1.5 text-xs font-medium text-muted select-none", inset && "pl-8"), className)}
            {...props}
        />
    );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
    return (
        <MenuPrimitive.Separator className={withBase("-mx-1 my-1 h-px bg-border", className)} {...props} />
    );
}

/** Right-aligned hint inside an item, e.g. `<Menu.Shortcut>Ctrl C</Menu.Shortcut>`. */
function MenuShortcut({ className, ...props }: ComponentProps<"span">) {
    return <span className={cn("ml-auto pl-4 text-xs tracking-wide text-muted", className)} {...props} />;
}

/** Nested menu: `Menu.SubTrigger` + `Menu.Content`. Opens on hover by default. */
function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
    return (
        <MenuKindContext value="submenu">
            <MenuPrimitive.SubmenuRoot {...props} />
        </MenuKindContext>
    );
}

export interface MenuSubTriggerProps extends MenuPrimitive.SubmenuTrigger.Props {
    inset?: boolean;
}

function MenuSubTrigger({ inset, className, children, ...props }: MenuSubTriggerProps) {
    return (
        <MenuPrimitive.SubmenuTrigger
            className={withBase(cn(itemBase, "data-popup-open:bg-hover", inset && "pl-8"), className)}
            {...props}
        >
            {children}
            <CaretRightIcon className="ml-auto size-3.5" />
        </MenuPrimitive.SubmenuTrigger>
    );
}

Menu.Trigger = MenuPrimitive.Trigger;
Menu.Content = MenuContent;
Menu.Item = MenuItem;
Menu.LinkItem = MenuLinkItem;
Menu.CheckboxItem = MenuCheckboxItem;
Menu.RadioGroup = MenuPrimitive.RadioGroup;
Menu.RadioItem = MenuRadioItem;
Menu.Group = MenuPrimitive.Group;
Menu.Label = MenuLabel;
Menu.Separator = MenuSeparator;
Menu.Shortcut = MenuShortcut;
Menu.Sub = MenuSub;
Menu.SubTrigger = MenuSubTrigger;
