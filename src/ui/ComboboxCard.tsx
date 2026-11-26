import type { ComponentProps } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { cardSearchClassName, popupClassName, searchInputClassName } from "./chip";

/**
 * A card picker's dropdown (folder, branch), above its chip: portalled into
 * the body, the popup (`popupClassName`; the width is the caller's).
 */
export function ComboboxCard({
    className,
    ...props
}: Omit<ComponentProps<typeof Combobox.Popup>, "className"> & { className?: string }) {
    return (
        <Combobox.Portal>
            <Combobox.Positioner
                side="top"
                align="start"
                sideOffset={8}
                // The extra room on top keeps it off the top bar, the
                // window's drag handle.
                collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                className="z-50 outline-none"
            >
                <Combobox.Popup className={cn(popupClassName, "rounded-xl p-1", className)} {...props} />
            </Combobox.Positioner>
        </Combobox.Portal>
    );
}

/** The search on top of a card, edge to edge. */
export function ComboboxCardSearch({ placeholder }: { placeholder: string }) {
    return (
        <label className={cardSearchClassName}>
            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted/75" />
            <Combobox.Input placeholder={placeholder} className={searchInputClassName} />
        </label>
    );
}
