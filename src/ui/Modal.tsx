import type { ComponentProps, FC, ReactElement, ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { iconButtonClassName } from "./iconButton";
import { usePortalContainer } from "./PortalContainer";

type Size = "sm" | "md" | "lg" | "xl";

const sizeStyles: Record<Size, string> = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-2xl"
};

type BaseDialogRootProps = ComponentProps<typeof BaseDialog.Root>;
type BaseDialogPortalProps = ComponentProps<typeof BaseDialog.Portal>;
type OpenChangeHandler = NonNullable<BaseDialogRootProps["onOpenChange"]>;

export interface ModalProps
    extends Omit<BaseDialogRootProps, "children" | "render"> {
    title?: ReactNode;
    trigger?: ReactElement;
    size?: Size;
    showClose?: boolean;
    container?: BaseDialogPortalProps["container"];
    children?: ReactNode;
    className?: string;
    backdropClassName?: string;
    titleClassName?: string;
    bodyClassName?: string;
}

const ModalRoot = ({
    title,
    trigger,
    size = "md",
    showClose = true,
    container,
    modal = "trap-focus",
    onOpenChange,
    children,
    className,
    backdropClassName,
    titleClassName,
    bodyClassName,
    ...rootProps
}: ModalProps) => {
    // Mounts into the shell's overlay layer, which starts below the top bar, so the backdrop dims
    // only the content area. Base UI reads an explicit `null` as "the container hasn't resolved
    // yet" and renders nothing, so fall through to `undefined` — its own default — when no
    // provider is in the tree.
    const portalContainer = usePortalContainer();

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
    };

    return (
        <BaseDialog.Root
            modal={modal}
            onOpenChange={handleOpenChange}
            {...rootProps}
        >
            {trigger && <BaseDialog.Trigger render={trigger} />}
            <BaseDialog.Portal
                container={container ?? portalContainer ?? undefined}
            >
                <BaseDialog.Backdrop
                    className={cn(
                        "pointer-events-auto absolute inset-0 z-50 bg-black/40",
                        "transition-opacity duration-200 ease-out",
                        "data-[starting-style]:opacity-0",
                        "data-[ending-style]:opacity-0",
                        backdropClassName
                    )}
                />
                <BaseDialog.Popup
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
                                <BaseDialog.Title
                                    className={cn(
                                        "text-base leading-tight font-semibold text-dark-50",
                                        titleClassName
                                    )}
                                >
                                    {title}
                                </BaseDialog.Title>
                            ) : (
                                <span />
                            )}
                            {showClose && (
                                <BaseDialog.Close
                                    className={cn(iconButtonClassName, "-m-0.5")}
                                >
                                    <XIcon className="size-4" />
                                </BaseDialog.Close>
                            )}
                        </div>
                    )}
                    <div className={cn("text-sm text-dark-100", bodyClassName)}>
                        {children}
                    </div>
                </BaseDialog.Popup>
            </BaseDialog.Portal>
        </BaseDialog.Root>
    );
};

ModalRoot.displayName = "Modal";

type BaseModalTriggerProps = ComponentProps<typeof BaseDialog.Trigger>;
export interface ModalTriggerProps extends BaseModalTriggerProps {}

const ModalTrigger = BaseDialog.Trigger as FC<ModalTriggerProps>;
(ModalTrigger as { displayName?: string }).displayName = "Modal.Trigger";

type BaseModalCloseProps = ComponentProps<typeof BaseDialog.Close>;
export interface ModalCloseProps extends BaseModalCloseProps {}

const ModalClose = BaseDialog.Close as FC<ModalCloseProps>;
(ModalClose as { displayName?: string }).displayName = "Modal.Close";

export const Modal = Object.assign(ModalRoot, {
    Trigger: ModalTrigger,
    Close: ModalClose
});
