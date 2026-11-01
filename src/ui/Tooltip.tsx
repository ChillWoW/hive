import type { ComponentProps, ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { usePortalContainer } from "./PortalContainer";
import { useBinding, type ShortcutRef } from "@/keybindings/runtime";
import { ShortcutKeys } from "@/keybindings/ShortcutKeys";
import { cn } from "@/lib/cn";

type BaseTooltipPositionerProps = ComponentProps<typeof BaseTooltip.Positioner>;
type BaseTooltipPopupProps = ComponentProps<typeof BaseTooltip.Popup>;

const popupBaseClassName = cn(
    "max-w-xs outline-none",
    "bg-dark-850 text-dark-50 border border-dark-600",
    "rounded-md shadow-lg shadow-black/40",
    "px-2 py-1 text-xs font-medium leading-snug",
    "[transform-origin:var(--transform-origin)]",
    "transition-[opacity,transform,scale] duration-150 ease-out",
    "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
    "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
    "data-[instant]:transition-none"
);

function TooltipProvider({
    delay = 150,
    closeDelay = 0,
    ...props
}: ComponentProps<typeof BaseTooltip.Provider>) {
    return <BaseTooltip.Provider delay={delay} closeDelay={closeDelay} {...props} />;
}

function TooltipTrigger({
    delay = 150,
    closeDelay = 0,
    closeOnClick = false,
    ...props
}: ComponentProps<typeof BaseTooltip.Trigger>) {
    return (
        <BaseTooltip.Trigger
            delay={delay}
            closeDelay={closeDelay}
            closeOnClick={closeOnClick}
            {...props}
        />
    );
}

export interface TooltipContentProps
    extends Omit<BaseTooltipPopupProps, "className" | "children"> {
    children?: ReactNode;
    side?: BaseTooltipPositionerProps["side"];
    align?: BaseTooltipPositionerProps["align"];
    sideOffset?: BaseTooltipPositionerProps["sideOffset"];
    alignOffset?: BaseTooltipPositionerProps["alignOffset"];
    collisionPadding?: BaseTooltipPositionerProps["collisionPadding"];
    className?: string;
    /**
     * Shown as muted text right of the label: an action id (its current
     * binding, nothing while unbound) or a fixed combo like `Escape`.
     */
    shortcut?: ShortcutRef;
}

function TooltipShortcut({ shortcut }: { shortcut: ShortcutRef }) {
    const binding = useBinding(shortcut);
    return <ShortcutKeys shortcut={binding} variant="plain" className="shrink-0 text-dark-250" />;
}

/** Portal, positioner and popup in one. */
function TooltipContent({
    children,
    side,
    align,
    sideOffset = 6,
    alignOffset,
    collisionPadding,
    className,
    shortcut,
    ...popupProps
}: TooltipContentProps) {
    // Mounts into the shell's overlay layer when one is provided. Base UI reads an explicit
    // `null` as "not resolved yet" and renders nothing, so fall through to `undefined`.
    const portalContainer = usePortalContainer();

    return (
        <BaseTooltip.Portal container={portalContainer ?? undefined}>
            <BaseTooltip.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset}
                alignOffset={alignOffset}
                collisionPadding={collisionPadding}
                className="z-50 outline-none"
            >
                <BaseTooltip.Popup className={cn(popupBaseClassName, className)} {...popupProps}>
                    {shortcut ? (
                        <span className="flex items-center gap-2">
                            <span className="min-w-0">{children}</span>
                            <TooltipShortcut shortcut={shortcut} />
                        </span>
                    ) : (
                        children
                    )}
                </BaseTooltip.Popup>
            </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
    );
}

/** Own function rather than `BaseTooltip.Root` itself, so `Object.assign` below attaches the parts
 *  to this wrapper instead of mutating Base UI's shared export. */
function TooltipRoot(props: ComponentProps<typeof BaseTooltip.Root>) {
    return <BaseTooltip.Root {...props} />;
}

export const Tooltip = Object.assign(TooltipRoot, {
    Provider: TooltipProvider,
    Trigger: TooltipTrigger,
    Content: TooltipContent
});
