import { forwardRef } from "react";
import type { ComponentProps, FC, ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { usePortalContainer } from "./PortalContainer";
import { useBinding, type ShortcutRef } from "@/keybindings/runtime";
import { ShortcutKeys } from "@/keybindings/ShortcutKeys";
import { cn } from "@/lib/cn";

type BaseTooltipProviderProps = ComponentProps<
    typeof BaseTooltip.Provider
>;
type BaseTooltipRootProps = ComponentProps<typeof BaseTooltip.Root>;
type BaseTooltipTriggerProps = ComponentProps<typeof BaseTooltip.Trigger>;
type BaseTooltipPortalProps = ComponentProps<typeof BaseTooltip.Portal>;
type BaseTooltipPositionerProps = ComponentProps<
    typeof BaseTooltip.Positioner
>;
type BaseTooltipPopupProps = ComponentProps<typeof BaseTooltip.Popup>;
type BaseTooltipViewportProps = ComponentProps<
    typeof BaseTooltip.Viewport
>;

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

export interface TooltipProviderProps extends BaseTooltipProviderProps {}

const TooltipProvider: FC<TooltipProviderProps> = ({
    delay = 150,
    closeDelay = 0,
    ...props
}) => <BaseTooltip.Provider delay={delay} closeDelay={closeDelay} {...props} />;
TooltipProvider.displayName = "Tooltip.Provider";

export interface TooltipProps extends BaseTooltipRootProps {}

const TooltipRoot = BaseTooltip.Root as FC<TooltipProps>;
(TooltipRoot as { displayName?: string }).displayName = "Tooltip";

export interface TooltipTriggerProps extends BaseTooltipTriggerProps {}

const TooltipTrigger: FC<TooltipTriggerProps> = ({
    delay = 150,
    closeDelay = 0,
    closeOnClick = false,
    ...props
}) => (
    <BaseTooltip.Trigger
        delay={delay}
        closeDelay={closeDelay}
        closeOnClick={closeOnClick}
        {...props}
    />
);
TooltipTrigger.displayName = "Tooltip.Trigger";

export interface TooltipPortalProps extends BaseTooltipPortalProps {}

const TooltipPortal = BaseTooltip.Portal as FC<TooltipPortalProps>;
(TooltipPortal as { displayName?: string }).displayName = "Tooltip.Portal";

export interface TooltipPositionerProps
    extends Omit<BaseTooltipPositionerProps, "className"> {
    className?: string;
}

const TooltipPositioner = forwardRef<
    HTMLDivElement,
    TooltipPositionerProps
>(({ className, sideOffset = 6, ...props }, ref) => (
    <BaseTooltip.Positioner
        ref={ref}
        sideOffset={sideOffset}
        className={cn("z-50 outline-none", className)}
        {...props}
    />
));
TooltipPositioner.displayName = "Tooltip.Positioner";

export interface TooltipPopupProps
    extends Omit<BaseTooltipPopupProps, "className"> {
    className?: string;
}

const TooltipPopup = forwardRef<HTMLDivElement, TooltipPopupProps>(
    ({ className, ...props }, ref) => (
        <BaseTooltip.Popup
            ref={ref}
            className={cn(popupBaseClassName, className)}
            {...props}
        />
    )
);
TooltipPopup.displayName = "Tooltip.Popup";

export interface TooltipViewportProps
    extends Omit<BaseTooltipViewportProps, "className"> {
    className?: string;
}

const TooltipViewport = forwardRef<HTMLDivElement, TooltipViewportProps>(
    ({ className, ...props }, ref) => (
        <BaseTooltip.Viewport
            ref={ref}
            className={cn("relative outline-none", className)}
            {...props}
        />
    )
);
TooltipViewport.displayName = "Tooltip.Viewport";

export interface TooltipContentProps
    extends Omit<BaseTooltipPopupProps, "className" | "children"> {
    children?: ReactNode;
    side?: BaseTooltipPositionerProps["side"];
    align?: BaseTooltipPositionerProps["align"];
    sideOffset?: BaseTooltipPositionerProps["sideOffset"];
    alignOffset?: BaseTooltipPositionerProps["alignOffset"];
    collisionPadding?: BaseTooltipPositionerProps["collisionPadding"];
    container?: BaseTooltipPortalProps["container"];
    keepMounted?: BaseTooltipPortalProps["keepMounted"];
    className?: string;
    positionerClassName?: string;
    arrowClassName?: string;
    /**
     * Shown as muted text right of the label: an action id (its current
     * binding, nothing while unbound) or a fixed combo like `Escape`.
     */
    shortcut?: ShortcutRef;
}

function TooltipShortcut({ shortcut }: { shortcut: ShortcutRef }) {
    const binding = useBinding(shortcut);
    return <ShortcutKeys shortcut={binding} variant="plain" className="shrink-0" />;
}

const TooltipContent = forwardRef<HTMLDivElement, TooltipContentProps>(
    (
        {
            children,
            side,
            align,
            sideOffset = 6,
            alignOffset,
            collisionPadding,
            container,
            keepMounted,
            className,
            positionerClassName,
            arrowClassName,
            shortcut,
            ...popupProps
        },
        ref
    ) => {
        // Same fallback as Modal: mount into the shell's overlay layer when one is
        // provided. Base UI reads an explicit `null` as "not resolved yet" and renders
        // nothing, so fall through to `undefined` when there is no provider.
        const portalContainer = usePortalContainer();

        return (
            <BaseTooltip.Portal
                container={container ?? portalContainer ?? undefined}
                keepMounted={keepMounted}
            >
                <BaseTooltip.Positioner
                    side={side}
                    align={align}
                    sideOffset={sideOffset}
                    alignOffset={alignOffset}
                    collisionPadding={collisionPadding}
                    className={cn("z-50 outline-none", positionerClassName)}
                >
                    <BaseTooltip.Popup
                        ref={ref}
                        className={cn(popupBaseClassName, className)}
                        {...popupProps}
                    >
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
);
TooltipContent.displayName = "Tooltip.Content";

export const Tooltip = Object.assign(TooltipRoot, {
    Provider: TooltipProvider,
    Trigger: TooltipTrigger,
    Portal: TooltipPortal,
    Positioner: TooltipPositioner,
    Popup: TooltipPopup,
    Viewport: TooltipViewport,
    Content: TooltipContent,
    createHandle: BaseTooltip.createHandle
});
