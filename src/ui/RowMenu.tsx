import type { ReactNode, SyntheticEvent } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { rowMenuTriggerClassName, sideMenuClassName } from "./chip";
import { Menu } from "./Menu";

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * A card picker row's "⋯" menu (`rowMenuTriggerClassName`), its items
 * (`children`) in a card beside the row. Its presses stay off the row, so
 * opening it or picking an item doesn't pick the row.
 */
export function RowMenu({
    label,
    open,
    onOpenChange,
    children
}: {
    /** The trigger's accessible name. */
    label: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
}) {
    return (
        <Menu open={open} onOpenChange={onOpenChange}>
            <Menu.Trigger
                aria-label={label}
                onPointerDown={stop}
                onMouseDown={stop}
                onMouseUp={stop}
                // The row cancels `pointerdown` to keep focus in the search, so no
                // `mousedown` arrives to open the menu the usual way.
                onClick={(event) => {
                    stop(event);
                    onOpenChange(!open);
                }}
                className={rowMenuTriggerClassName}
            >
                <DotsThreeIcon className="size-3.5" weight="bold" />
            </Menu.Trigger>
            {/* Portalled, but React events still bubble to the row. */}
            <Menu.Content
                side="right"
                align="start"
                sideOffset={12}
                alignOffset={-5}
                onPointerDown={stop}
                onPointerUp={stop}
                onMouseDown={stop}
                onMouseUp={stop}
                onClick={stop}
                className={sideMenuClassName}
            >
                {children}
            </Menu.Content>
        </Menu>
    );
}
