import type { ComponentProps } from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "./Menu";
import { MenuSideOffsetContext } from "./MenuSideOffsetContext";
import { mergeClassName } from "@/lib/cn";

/** Leaves the root popup's offset to Base UI, which places it by the cursor; submenus reset the gap
 *  through their own SubmenuRoot. */
function ContextMenuRoot(props: ComponentProps<typeof BaseContextMenu.Root>) {
    return (
        <MenuSideOffsetContext value={undefined}>
            <BaseContextMenu.Root {...props} />
        </MenuSideOffsetContext>
    );
}

function ContextMenuTrigger({ className, ...props }: ComponentProps<typeof BaseContextMenu.Trigger>) {
    return <BaseContextMenu.Trigger className={mergeClassName("outline-none", className)} {...props} />;
}

/** Only Root and Trigger are context-menu specific; Base UI builds the rest from Menu's parts, so
 *  the styled Menu parts are reused as they are. */
export const ContextMenu = Object.assign(ContextMenuRoot, {
    Trigger: ContextMenuTrigger,
    Content: Menu.Content,
    Item: Menu.Item,
    Separator: Menu.Separator
});
