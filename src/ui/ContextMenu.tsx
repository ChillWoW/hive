import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@/lib/cn";
import { Menu } from "./Menu";
import { MenuKindContext } from "./menu-kind";

/**
 * Menu opened by right-click (or long-press) on `ContextMenu.Trigger`, positioned at
 * the pointer. Content, items, groups and submenus are the same parts as `Menu`.
 */
export function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
    return (
        <MenuKindContext value="context">
            <ContextMenuPrimitive.Root {...props} />
        </MenuKindContext>
    );
}

/** The area that opens the menu. Renders a `<div>`; use `render` to swap the element. */
function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
    return (
        <ContextMenuPrimitive.Trigger
            className={(state) =>
                cn("select-none", typeof className === "function" ? className(state) : className)
            }
            {...props}
        />
    );
}

ContextMenu.Trigger = ContextMenuTrigger;
ContextMenu.Content = Menu.Content;
ContextMenu.Item = Menu.Item;
ContextMenu.LinkItem = Menu.LinkItem;
ContextMenu.CheckboxItem = Menu.CheckboxItem;
ContextMenu.RadioGroup = Menu.RadioGroup;
ContextMenu.RadioItem = Menu.RadioItem;
ContextMenu.Group = Menu.Group;
ContextMenu.Label = Menu.Label;
ContextMenu.Separator = Menu.Separator;
ContextMenu.Shortcut = Menu.Shortcut;
ContextMenu.Sub = Menu.Sub;
ContextMenu.SubTrigger = Menu.SubTrigger;
