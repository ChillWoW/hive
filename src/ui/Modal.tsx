import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { iconButtonClassName } from "./IconButton";
import { useChromeLayer, usePortalContainer } from "./PortalContainer";

type Size = "sm" | "md" | "xl";

const sizeStyles: Record<Size, string> = {
    sm: "max-w-sm",
    md: "max-w-md",
    xl: "max-w-2xl"
};

type BaseDialogRootProps = ComponentProps<typeof BaseDialog.Root>;
type OpenChangeHandler = NonNullable<BaseDialogRootProps["onOpenChange"]>;

export interface ModalProps
    extends Omit<BaseDialogRootProps, "children" | "render"> {
    title?: ReactNode;
    size?: Size;
    showClose?: boolean;
    children?: ReactNode;
    className?: string;
    backdropClassName?: string;
    bodyClassName?: string;
    /** Called when the dialog asks to close (Escape, backdrop, ✕). */
    onClose?: () => void;
    /** Where focus goes on close (Base UI's `Popup.finalFocus`); default: back where it was. */
    finalFocus?: ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
}

const backdropClassNames = cn(
    "bg-black/40 transition-opacity duration-200 ease-out",
    "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
);

function ModalRoot({
    title,
    size = "md",
    showClose = true,
    modal = "trap-focus",
    onOpenChange,
    onClose,
    children,
    className,
    backdropClassName,
    bodyClassName,
    finalFocus,
    ...rootProps
}: ModalProps) {
    // Mounts into the shell's overlay layer, which starts below the top bar, so the backdrop dims
    // only the content area. Base UI reads an explicit `null` as "the container hasn't resolved
    // yet" and renders nothing, so fall through to `undefined` — its own default — when no
    // provider is in the tree.
    const portalContainer = usePortalContainer();
    const chromeLayer = useChromeLayer();

    // `modal={true}` makes Base UI render its own `position: fixed; inset: 0` backdrop over the
    // whole viewport, which swallows presses on the top bar and kills window dragging.
    // `"trap-focus"` keeps the focus trap and drops that backdrop.
    const handleOpenChange: OpenChangeHandler = (nextOpen, details) => {
        // With the chrome left interactive, presses on it now reach the dismiss logic. Only a
        // press landing inside the overlay layer — the backdrop — should close the dialog;
        // dragging the window or hitting a window control must not.
        if (!nextOpen && details.reason === "outside-press" && portalContainer) {
            const target = details.event.target;
            if (target instanceof Node && !portalContainer.contains(target)) {
                details.cancel();
                return;
            }
        }

        onOpenChange?.(nextOpen, details);
        if (!nextOpen) onClose?.();
    };

    return (
        <BaseDialog.Root modal={modal} onOpenChange={handleOpenChange} {...rootProps}>
            <BaseDialog.Portal container={portalContainer ?? undefined}>
                {/* The top bar dims too, only to look: the strip under the dim is a drag region,
                    so the window still moves, and it stops short of the window controls
                    (`--chrome-controls`), which stay clickable. Presses here land outside the
                    overlay layer, so they never dismiss the dialog. It's a plain div mirroring
                    the backdrop's state: a second `Dialog.Backdrop` would take over the
                    dialog's backdrop ref, and presses on the real one would stop closing it. */}
                <BaseDialog.Backdrop
                    className={cn(
                        "pointer-events-auto absolute inset-0 z-50",
                        backdropClassNames,
                        backdropClassName
                    )}
                    render={(props, state) => (
                        <>
                            <div {...props} />
                            {chromeLayer &&
                                createPortal(
                                    <div
                                        hidden={props.hidden}
                                        data-starting-style={
                                            state.transitionStatus === "starting" ? "" : undefined
                                        }
                                        data-ending-style={
                                            state.transitionStatus === "ending" ? "" : undefined
                                        }
                                        className={cn(
                                            "pointer-events-none absolute inset-0",
                                            backdropClassNames,
                                            backdropClassName
                                        )}
                                    >
                                        <div
                                            data-tauri-drag-region
                                            className="pointer-events-auto absolute inset-y-0 left-0 right-(--chrome-controls)"
                                        />
                                    </div>,
                                    chromeLayer
                                )}
                        </>
                    )}
                />
                <BaseDialog.Popup
                    finalFocus={finalFocus}
                    className={cn(
                        "pointer-events-auto absolute top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
                        "bg-dark-850 text-dark-50 border border-dark-600",
                        "rounded-md shadow-lg shadow-black/40",
                        "p-4 outline-none",
                        "transition-[opacity,transform,scale] duration-200 ease-out",
                        "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
                        "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
                        sizeStyles[size],
                        className
                    )}
                >
                    {(title || showClose) && (
                        <div className="mb-3 flex items-start justify-between gap-4">
                            {title ? (
                                <BaseDialog.Title className="text-base leading-tight font-semibold text-dark-50">
                                    {title}
                                </BaseDialog.Title>
                            ) : (
                                <span />
                            )}
                            {showClose && (
                                <BaseDialog.Close className={cn(iconButtonClassName, "-m-0.5")}>
                                    <XIcon className="size-4" />
                                </BaseDialog.Close>
                            )}
                        </div>
                    )}
                    <div className={cn("text-sm text-dark-100", bodyClassName)}>{children}</div>
                </BaseDialog.Popup>
            </BaseDialog.Portal>
        </BaseDialog.Root>
    );
}

export const Modal = Object.assign(ModalRoot, {
    Close: BaseDialog.Close
});

/**
 * `value`, or the last non-null one while it's null: a dialog driven by a
 * nullable subject keeps showing it while it animates out.
 */
export function useLastNonNull<T>(value: T | null): T | null {
    const [last, setLast] = useState(value);
    useEffect(() => {
        if (value !== null) setLast(value);
    }, [value]);
    return value ?? last;
}
