import type { ComponentProps } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { cardSearchClassName, popupClassName, searchInputClassName } from "./chip";
import { usePortalContainer } from "./PortalContainer";

/**
 * A card picker's dropdown (folder, branch), above its chip: portalled into
 * the overlay layer, the popup (`popupClassName`; the width is the caller's).
 */
export function ComboboxCard({
    className,
    ...props
}: Omit<ComponentProps<typeof Combobox.Popup>, "className"> & { className?: string }) {
    const container = usePortalContainer();
    return (
        <Combobox.Portal container={container ?? undefined}>
            <Combobox.Positioner
                side="top"
                align="start"
                sideOffset={8}
                collisionPadding={12}
                className="z-50 outline-none"
            >
                <Combobox.Popup className={cn(popupClassName, className)} {...props} />
            </Combobox.Positioner>
        </Combobox.Portal>
    );
}

/** The search on top of a card, edge to edge. */
export function ComboboxCardSearch({ placeholder }: { placeholder: string }) {
    return (
        <label className={cardSearchClassName}>
            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-250" />
            <Combobox.Input placeholder={placeholder} className={searchInputClassName} />
        </label>
    );
}
