import type { ComponentProps } from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "./Menu";
import { MenuSideOffsetContext } from "./MenuSideOffsetContext";
import { mergeClassName } from "@/lib/cn";

export type ContextMenuProps = ComponentProps<typeof BaseContextMenu.Root>;

/** Leaves the root popup's offset to Base UI, which places it by the cursor; submenus reset the gap
 *  through their own SubmenuRoot. */
function ContextMenuRoot(props: ContextMenuProps) {
    return (
        <MenuSideOffsetContext value={undefined}>
            <BaseContextMenu.Root {...props} />
        </MenuSideOffsetContext>
    );
}

export type ContextMenuTriggerProps = ComponentProps<
    typeof BaseContextMenu.Trigger
>;

function ContextMenuTrigger({ className, ...props }: ContextMenuTriggerProps) {
    return (
        <BaseContextMenu.Trigger
            className={mergeClassName("outline-none", className)}
            {...props}
        />
    );
}

export type ContextMenuBackdropProps = ComponentProps<
    typeof BaseContextMenu.Backdrop
>;

function ContextMenuBackdrop({ className, ...props }: ContextMenuBackdropProps) {
    return (
        <BaseContextMenu.Backdrop
            className={mergeClassName("z-40", className)}
            {...props}
        />
    );
}

/** Only Root, Trigger and Backdrop are context-menu specific; Base UI builds the rest from Menu's
 *  parts, so the styled Menu parts are reused as they are. */
export const ContextMenu = Object.assign(ContextMenuRoot, {
    Trigger: ContextMenuTrigger,
    Backdrop: ContextMenuBackdrop,
    Portal: Menu.Portal,
    Positioner: Menu.Positioner,
    Popup: Menu.Popup,
    Content: Menu.Content,
    Item: Menu.Item,
    LinkItem: Menu.LinkItem,
    Separator: Menu.Separator,
    Group: Menu.Group,
    GroupLabel: Menu.GroupLabel,
    RadioGroup: Menu.RadioGroup,
    RadioItem: Menu.RadioItem,
    CheckboxItem: Menu.CheckboxItem,
    SubmenuRoot: Menu.SubmenuRoot,
    SubmenuTrigger: Menu.SubmenuTrigger
});
