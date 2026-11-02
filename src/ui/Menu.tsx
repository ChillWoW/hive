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
    "rounded-md shadow-lg shadow-black/40",
    "[transform-origin:var(--transform-origin)]",
    "transition-[opacity,transform,scale] duration-150 ease-out",
    "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
    "data-[ending-style]:opacity-0 data-[ending-style]:scale-95"
);

const itemBaseClassName = cn(
    "relative flex w-full cursor-pointer select-none items-center gap-2",
    "rounded-sm px-2.5 py-1.5 text-xs text-dark-50 outline-none transition-colors",
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

type MenuPositionerProps = ComponentProps<typeof BaseMenu.Positioner>;

type MenuContentProps = ComponentProps<typeof BaseMenu.Popup> &
    Pick<MenuPositionerProps, "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding">;

/** Portal (the shell's overlay layer), positioner and popup in one. */
function MenuContent({
    side,
    align,
    sideOffset,
    alignOffset,
    collisionPadding,
    className,
    ...popupProps
}: MenuContentProps) {
    const portalContainer = usePortalContainer();
    const defaultSideOffset = useContext(MenuSideOffsetContext);
    return (
        <BaseMenu.Portal container={portalContainer ?? undefined}>
            <BaseMenu.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset ?? defaultSideOffset}
                alignOffset={alignOffset}
                collisionPadding={collisionPadding}
                className="z-50 outline-none"
            >
                <BaseMenu.Popup
                    className={mergeClassName(popupBaseClassName, className)}
                    {...popupProps}
                />
            </BaseMenu.Positioner>
        </BaseMenu.Portal>
    );
}

type MenuItemProps = ComponentProps<typeof BaseMenu.Item> & {
    /** `danger` keeps the normal text colour at rest and turns red only while highlighted. */
    variant?: ItemVariant;
};

function MenuItem({ variant = "default", className, ...props }: MenuItemProps) {
    return (
        <BaseMenu.Item
            className={mergeClassName([itemBaseClassName, itemVariantStyles[variant]], className)}
            {...props}
        />
    );
}

function MenuSeparator({ className, ...props }: ComponentProps<typeof BaseMenu.Separator>) {
    return (
        <BaseMenu.Separator
            className={mergeClassName("-mx-1 my-1 h-px bg-dark-600", className)}
            {...props}
        />
    );
}

function MenuGroupLabel({ className, ...props }: ComponentProps<typeof BaseMenu.GroupLabel>) {
    return (
        <BaseMenu.GroupLabel
            className={mergeClassName("px-2.5 py-1 text-[11px] font-medium text-dark-200", className)}
            {...props}
        />
    );
}

function MenuRadioItem({ className, children, ...props }: ComponentProps<typeof BaseMenu.RadioItem>) {
    return (
        <BaseMenu.RadioItem className={mergeClassName(indicatorItemClassName, className)} {...props}>
            <BaseMenu.RadioItemIndicator className={indicatorWrapperClassName}>
                <CircleIcon className="size-2" weight="fill" aria-hidden />
            </BaseMenu.RadioItemIndicator>
            {children}
        </BaseMenu.RadioItem>
    );
}

function MenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof BaseMenu.CheckboxItem>) {
    return (
        <BaseMenu.CheckboxItem className={mergeClassName(indicatorItemClassName, className)} {...props}>
            <BaseMenu.CheckboxItemIndicator className={indicatorWrapperClassName}>
                <CheckIcon className="size-3.5" weight="bold" aria-hidden />
            </BaseMenu.CheckboxItemIndicator>
            {children}
        </BaseMenu.CheckboxItem>
    );
}

/** Sets the gap back for its popup, inside either kind of menu. */
function MenuSubmenuRoot(props: ComponentProps<typeof BaseMenu.SubmenuRoot>) {
    return (
        <MenuSideOffsetContext value={6}>
            <BaseMenu.SubmenuRoot {...props} />
        </MenuSideOffsetContext>
    );
}

function MenuSubmenuTrigger({
    className,
    children,
    ...props
}: ComponentProps<typeof BaseMenu.SubmenuTrigger>) {
    return (
        <BaseMenu.SubmenuTrigger
            className={mergeClassName([itemBaseClassName, "data-[popup-open]:bg-dark-700"], className)}
            {...props}
        >
            {children}
            <CaretRightIcon className="ml-auto size-3.5 shrink-0 text-dark-100" aria-hidden />
        </BaseMenu.SubmenuTrigger>
    );
}

/** Own function rather than `BaseMenu.Root` itself, so `Object.assign` below attaches the parts to
 *  this wrapper instead of mutating Base UI's shared export. */
function MenuRoot<Payload>(props: MenuProps<Payload>) {
    return <BaseMenu.Root {...props} />;
}

/** Base UI's ContextMenu is built from these same parts, so ContextMenu reuses them. */
export const Menu = Object.assign(MenuRoot, {
    Trigger: BaseMenu.Trigger,
    Content: MenuContent,
    Item: MenuItem,
    Separator: MenuSeparator,
    GroupLabel: MenuGroupLabel,
    Group: BaseMenu.Group,
    RadioGroup: BaseMenu.RadioGroup,
    RadioItem: MenuRadioItem,
    CheckboxItem: MenuCheckboxItem,
    SubmenuRoot: MenuSubmenuRoot,
    SubmenuTrigger: MenuSubmenuTrigger
});
