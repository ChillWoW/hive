import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { Button } from "./Button";

/** Width of the top bar's window controls (`layout/WindowControls`), left clear of a modal's drag strip. */
const WINDOW_CONTROLS_WIDTH = isMac ? 0 : 88;

type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

function withBase<State>(base: string, className: ClassName<State>) {
    return (state: State) => cn(base, typeof className === "function" ? className(state) : className);
}

const sizes = {
    sm: "max-w-sm",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
} as const;

export type ModalSize = keyof typeof sizes;

/**
 * Dialog that blocks the page until closed (Base UI's `Dialog`). Compose with
 * `Modal.Trigger` and `Modal.Content` (holding `Modal.Header`, `Modal.Body`, `Modal.Footer`).
 * Control it with `open`/`onOpenChange`; `disablePointerDismissal` keeps it open on outside clicks.
 */
export function Modal(props: DialogPrimitive.Root.Props) {
    return <DialogPrimitive.Root {...props} />;
}

export interface ModalContentProps extends DialogPrimitive.Popup.Props {
    /** Max width of the popup. Default `md`. */
    size?: ModalSize;
    /** Renders an X button in the top-right corner. Default `true`. */
    showCloseButton?: boolean;
    /** Where to portal the modal. Defaults to `document.body`. */
    container?: DialogPrimitive.Portal.Props["container"];
}

/**
 * The backdrop and centered popup. Grows with its content up to the viewport height;
 * past that, `Modal.Body` scrolls while the header and footer stay put.
 */
function ModalContent({
    size = "md",
    showCloseButton = true,
    container,
    className,
    children,
    ...props
}: ModalContentProps) {
    return (
        <DialogPrimitive.Portal container={container}>
            <DialogPrimitive.Backdrop
                className={cn(
                    "fixed inset-0 bg-black/60 transition-opacity duration-150 ease-out",
                    "data-starting-style:opacity-0 data-ending-style:opacity-0",
                )}
            />
            {/* The top bar stays usable under the dim: this strip keeps the window draggable
                (presses off the backdrop never dismiss), the window controls sit above it, and
                the popup centres below the bar. */}
            <div
                data-tauri-drag-region
                style={{ right: WINDOW_CONTROLS_WIDTH }}
                className="fixed top-0 left-0 h-9"
            />
            <DialogPrimitive.Viewport className="fixed inset-x-0 top-9 bottom-0 flex items-center justify-center p-4">
                <DialogPrimitive.Popup
                    className={withBase(
                        cn(
                            "relative flex max-h-full w-full flex-col gap-4 rounded-md border border-border bg-surface p-4 text-text shadow-2xl shadow-black/50 outline-none",
                            "transition-[opacity,scale] duration-150 ease-out",
                            "data-starting-style:scale-95 data-starting-style:opacity-0",
                            "data-ending-style:scale-95 data-ending-style:opacity-0",
                            // A nested modal pushes this one back: shrink it and dim it (nested backdrops don't render).
                            "data-nested-dialog-open:scale-[calc(1-0.04*var(--nested-dialogs))]",
                            "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-black/0 after:transition-colors after:duration-150",
                            "data-nested-dialog-open:after:bg-black/40",
                            // Keep the header text clear of the close button.
                            showCloseButton && "[&_[data-slot=modal-header]]:pr-8",
                            sizes[size],
                        ),
                        className,
                    )}
                    {...props}
                >
                    {children}
                    {showCloseButton && (
                        <DialogPrimitive.Close
                            render={<Button variant="ghost" size="icon-sm" />}
                            aria-label="Close"
                            className="absolute top-2 right-2 text-muted hover:text-text"
                        >
                            <XIcon />
                        </DialogPrimitive.Close>
                    )}
                </DialogPrimitive.Popup>
            </DialogPrimitive.Viewport>
        </DialogPrimitive.Portal>
    );
}

/** Holds `Modal.Title` and `Modal.Description`. */
function ModalHeader({ className, ...props }: ComponentProps<"div">) {
    return <div data-slot="modal-header" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

/** Labels the modal for screen readers. */
function ModalTitle({ className, ...props }: DialogPrimitive.Title.Props) {
    return (
        <DialogPrimitive.Title
            className={withBase("text-base leading-tight font-semibold text-text", className)}
            {...props}
        />
    );
}

/** Describes the modal for screen readers. */
function ModalDescription({ className, ...props }: DialogPrimitive.Description.Props) {
    return <DialogPrimitive.Description className={withBase("text-sm text-muted", className)} {...props} />;
}

/** Main content. Scrolls when the modal hits the viewport height. */
function ModalBody({ className, ...props }: ComponentProps<"div">) {
    return (
        <div
            data-slot="modal-body"
            className={cn("-mx-4 min-h-0 flex-1 overflow-y-auto px-4 text-sm", className)}
            {...props}
        />
    );
}

/** Action row, right-aligned. Stacks (primary on top) on narrow screens. */
function ModalFooter({ className, ...props }: ComponentProps<"div">) {
    return (
        <div
            data-slot="modal-footer"
            className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
            {...props}
        />
    );
}

Modal.Trigger = DialogPrimitive.Trigger;
Modal.Content = ModalContent;
Modal.Header = ModalHeader;
Modal.Title = ModalTitle;
Modal.Description = ModalDescription;
Modal.Body = ModalBody;
Modal.Footer = ModalFooter;
/** Closes the modal. Use `render={<Button />}` for a styled button. */
Modal.Close = DialogPrimitive.Close;
