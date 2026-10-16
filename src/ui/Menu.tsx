import { useContext } from "react";
import type { ComponentProps } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { CaretRightIcon, CheckIcon, CircleIcon } from "@phosphor-icons/react";
import { MenuSideOffsetContext } from "./MenuSideOffsetContext";
import { usePortalContainer } from "./PortalContainer";
import { cn, mergeClassName } from "@/lib/cn";

type ItemVariant = "default" | "danger";

// `pointer-events-auto` because the overlay layer popups portal into is
// click-through (`PortalContainerProvider`).
const popupBaseClassName = cn(
    "pointer-events-auto min-w-[10rem] max-h-[var(--available-height)] overflow-y-auto outline-none p-1",
    "bg-dark-850 text-dark-50 border border-dark-600",
    "rounded-sm shadow-lg shadow-black/40",
    "[transform-origin:var(--transform-origin)]",
    "transition-[opacity,transform,scale] duration-150 ease-out",
    "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
    "data-[ending-style]:opacity-0 data-[ending-style]:scale-95"
);

const positionerBaseClassName = "z-50 outline-none";

const itemBaseClassName = cn(
    "relative flex w-full cursor-pointer select-none items-center gap-2",
    "rounded-xs px-2.5 py-1.5 text-xs text-dark-50 outline-none transition-colors",
    "data-[highlighted]:bg-dark-700",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

const itemVariantStyles: Record<ItemVariant, string> = {
    default: "",
    danger: "data-[highlighted]:bg-danger/15 data-[highlighted]:text-danger"
};

/** Items with a check or radio indicator reserve the inset gutter the indicator sits in. */
const indicatorItemClassName = cn(itemBaseClassName, "pl-7");

const indicatorWrapperClassName = cn(
    "absolute left-1.5 inline-flex size-4 shrink-0 items-center justify-center text-dark-50",
    "data-[unchecked]:hidden",
    "transition-opacity",
    "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
);

export type MenuProps<Payload = unknown> = BaseMenu.Root.Props<Payload>;

export type MenuTriggerProps = ComponentProps<typeof BaseMenu.Trigger>;

export type MenuPortalProps = ComponentProps<typeof BaseMenu.Portal>;

export type MenuPositionerProps = ComponentProps<
    typeof BaseMenu.Positioner
>;

function MenuPositioner({
    className,
    sideOffset,
    ...props
}: MenuPositionerProps) {
    const defaultSideOffset = useContext(MenuSideOffsetContext);

    return (
        <BaseMenu.Positioner
            sideOffset={sideOffset ?? defaultSideOffset}
            className={mergeClassName(positionerBaseClassName, className)}
            {...props}
        />
    );
}

export type MenuPopupProps = ComponentProps<typeof BaseMenu.Popup>;

function MenuPopup({ className, ...props }: MenuPopupProps) {
    return (
        <BaseMenu.Popup
            className={mergeClassName(popupBaseClassName, className)}
            {...props}
        />
    );
}

export type MenuContentProps = MenuPopupProps &
    Pick<
        MenuPositionerProps,
        "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
    > &
    Pick<MenuPortalProps, "container" | "keepMounted"> & {
        positionerClassName?: MenuPositionerProps["className"];
    };

/** Portal, positioner and popup in one, for the common case of a menu that needs no custom
 *  positioning layer. */
function MenuContent({
    side,
    align,
    sideOffset,
    alignOffset,
    collisionPadding,
    container,
    keepMounted,
    positionerClassName,
    ...popupProps
}: MenuContentProps) {
    const portalContainer = usePortalContainer();
    return (
        <BaseMenu.Portal
            container={container ?? portalContainer ?? undefined}
            keepMounted={keepMounted}
        >
            <MenuPositioner
                side={side}
                align={align}
                sideOffset={sideOffset}
                alignOffset={alignOffset}
                collisionPadding={collisionPadding}
                className={positionerClassName}
            >
                <MenuPopup {...popupProps} />
            </MenuPositioner>
        </BaseMenu.Portal>
    );
}

export type MenuItemProps = ComponentProps<typeof BaseMenu.Item> & {
    inset?: boolean;
    /** `danger` keeps the normal text colour at rest and turns red only while highlighted. */
    variant?: ItemVariant;
};

function MenuItem({
    inset,
    variant = "default",
    className,
    ...props
}: MenuItemProps) {
    return (
        <BaseMenu.Item
            className={mergeClassName(
                [itemBaseClassName, itemVariantStyles[variant], inset && "pl-7"],
                className
            )}
            {...props}
        />
    );
}

export type MenuLinkItemProps = ComponentProps<
    typeof BaseMenu.LinkItem
> & {
    inset?: boolean;
};

function MenuLinkItem({ inset, className, ...props }: MenuLinkItemProps) {
    return (
        <BaseMenu.LinkItem
            className={mergeClassName(
                [itemBaseClassName, "no-underline", inset && "pl-7"],
                className
            )}
            {...props}
        />
    );
}

export type MenuSeparatorProps = ComponentProps<typeof BaseMenu.Separator>;

function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
    return (
        <BaseMenu.Separator
            className={mergeClassName("-mx-1 my-1 h-px bg-dark-600", className)}
            {...props}
        />
    );
}

export type MenuGroupProps = ComponentProps<typeof BaseMenu.Group>;

export type MenuGroupLabelProps = ComponentProps<
    typeof BaseMenu.GroupLabel
>;

function MenuGroupLabel({ className, ...props }: MenuGroupLabelProps) {
    return (
        <BaseMenu.GroupLabel
            className={mergeClassName(
                "px-2.5 py-1 text-[11px] font-medium text-dark-200",
                className
            )}
            {...props}
        />
    );
}

export type MenuRadioGroupProps = ComponentProps<
    typeof BaseMenu.RadioGroup
>;

export type MenuRadioItemProps = ComponentProps<
    typeof BaseMenu.RadioItem
> & {
    indicatorClassName?: string;
};

function MenuRadioItem({
    className,
    indicatorClassName,
    children,
    ...props
}: MenuRadioItemProps) {
    return (
        <BaseMenu.RadioItem
            className={mergeClassName(indicatorItemClassName, className)}
            {...props}
        >
            <BaseMenu.RadioItemIndicator
                className={cn(indicatorWrapperClassName, indicatorClassName)}
            >
                <CircleIcon className="size-2" weight="fill" aria-hidden />
            </BaseMenu.RadioItemIndicator>
            {children}
        </BaseMenu.RadioItem>
    );
}

export type MenuCheckboxItemProps = ComponentProps<
    typeof BaseMenu.CheckboxItem
> & {
    indicatorClassName?: string;
};

function MenuCheckboxItem({
    className,
    indicatorClassName,
    children,
    ...props
}: MenuCheckboxItemProps) {
    return (
        <BaseMenu.CheckboxItem
            className={mergeClassName(indicatorItemClassName, className)}
            {...props}
        >
            <BaseMenu.CheckboxItemIndicator
                className={cn(indicatorWrapperClassName, indicatorClassName)}
            >
                <CheckIcon className="size-3.5" weight="bold" aria-hidden />
            </BaseMenu.CheckboxItemIndicator>
            {children}
        </BaseMenu.CheckboxItem>
    );
}

export type MenuSubmenuRootProps = ComponentProps<
    typeof BaseMenu.SubmenuRoot
>;

function MenuSubmenuRoot(props: MenuSubmenuRootProps) {
    return (
        <MenuSideOffsetContext value={6}>
            <BaseMenu.SubmenuRoot {...props} />
        </MenuSideOffsetContext>
    );
}

export type MenuSubmenuTriggerProps = ComponentProps<
    typeof BaseMenu.SubmenuTrigger
> & {
    inset?: boolean;
};

function MenuSubmenuTrigger({
    inset,
    className,
    children,
    ...props
}: MenuSubmenuTriggerProps) {
    return (
        <BaseMenu.SubmenuTrigger
            className={mergeClassName(
                [
                    itemBaseClassName,
                    "data-[popup-open]:bg-dark-700",
                    inset && "pl-7"
                ],
                className
            )}
            {...props}
        >
            {children}
            <CaretRightIcon
                className="ml-auto size-3.5 shrink-0 text-dark-100"
                aria-hidden
            />
        </BaseMenu.SubmenuTrigger>
    );
}

/** Own function rather than `BaseMenu.Root` itself, so `Object.assign` below attaches the parts to
 *  this wrapper instead of mutating Base UI's shared export. */
function MenuRoot<Payload>(props: MenuProps<Payload>) {
    return <BaseMenu.Root {...props} />;
}

/** Base UI's ContextMenu is built from these same parts, so ContextMenu reuses everything here
 *  except Root, Trigger and Backdrop. */
export const Menu = Object.assign(MenuRoot, {
    Trigger: BaseMenu.Trigger,
    Portal: BaseMenu.Portal,
    Positioner: MenuPositioner,
    Popup: MenuPopup,
    Content: MenuContent,
    Item: MenuItem,
    LinkItem: MenuLinkItem,
    Separator: MenuSeparator,
    Group: BaseMenu.Group,
    GroupLabel: MenuGroupLabel,
    RadioGroup: BaseMenu.RadioGroup,
    RadioItem: MenuRadioItem,
    CheckboxItem: MenuCheckboxItem,
    SubmenuRoot: MenuSubmenuRoot,
    SubmenuTrigger: MenuSubmenuTrigger,
    createHandle: BaseMenu.createHandle
});
