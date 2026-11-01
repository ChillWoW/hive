import type { ComponentProps } from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { cn } from "@/lib/cn";
import { usePortalContainer } from "./PortalContainer";

const popupBaseClassName = cn(
    // The overlay layer it portals into is click-through; the popup is not.
    "pointer-events-auto min-w-[12rem] outline-none",
    "bg-dark-850 text-dark-50 border border-dark-600",
    "rounded-md shadow-lg shadow-black/40",
    "p-3",
    "[transform-origin:var(--transform-origin)]",
    "transition-[opacity,transform,scale] duration-150 ease-out",
    "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
    "data-[ending-style]:opacity-0 data-[ending-style]:scale-95"
);

type PopoverPortalProps = ComponentProps<typeof BasePopover.Portal>;

/** Mounts into the shell's overlay layer unless given a `container`. */
function PopoverPortal({ container, ...props }: PopoverPortalProps) {
    const portalContainer = usePortalContainer();
    return <BasePopover.Portal container={container ?? portalContainer ?? undefined} {...props} />;
}

interface PopoverPositionerProps
    extends Omit<ComponentProps<typeof BasePopover.Positioner>, "className"> {
    className?: string;
}

function PopoverPositioner({ className, sideOffset = 8, ...props }: PopoverPositionerProps) {
    return (
        <BasePopover.Positioner
            sideOffset={sideOffset}
            className={cn("z-50 outline-none", className)}
            {...props}
        />
    );
}

interface PopoverPopupProps extends Omit<ComponentProps<typeof BasePopover.Popup>, "className"> {
    className?: string;
}

function PopoverPopup({ className, ...props }: PopoverPopupProps) {
    return <BasePopover.Popup className={cn(popupBaseClassName, className)} {...props} />;
}

/** Own function rather than `BasePopover.Root` itself, so `Object.assign` below attaches the parts
 *  to this wrapper instead of mutating Base UI's shared export. */
function PopoverRoot(props: ComponentProps<typeof BasePopover.Root>) {
    return <BasePopover.Root {...props} />;
}

export const Popover = Object.assign(PopoverRoot, {
    Trigger: BasePopover.Trigger,
    Portal: PopoverPortal,
    Positioner: PopoverPositioner,
    Popup: PopoverPopup
});
