import { createContext, useContext, type ReactNode } from "react";
import type { ModalSize } from "./Modal";

/** Passed to a stacked modal's `content` function. */
export interface ModalStackItemControls {
    /** Id of this modal in the stack. */
    id: string;
    /** Closes this modal (and any stacked above it). */
    close: () => void;
}

export interface ModalStackItem {
    /**
     * What goes inside `Modal.Content`: usually `Modal.Header`, `Modal.Body` and `Modal.Footer`.
     * Pass a function to get `close` for closing this modal after async work.
     */
    content: ReactNode | ((controls: ModalStackItemControls) => ReactNode);
    /** Max width of the popup. Default `md`. */
    size?: ModalSize;
    /** Renders an X button in the top-right corner. Default `true`. */
    showCloseButton?: boolean;
    /** Keeps the modal open on outside clicks. */
    disablePointerDismissal?: boolean;
    /** Called when the modal starts closing, however it was closed. */
    onClose?: () => void;
}

export interface ModalStackApi {
    /** Pushes a modal on top of the stack and returns its id. */
    open: (item: ModalStackItem) => string;
    /** Closes the modal with `id` and everything above it. Without `id`, closes the top one. */
    close: (id?: string) => void;
    /** Closes every modal in the stack. */
    closeAll: () => void;
    /** Number of open modals. */
    count: number;
}

export const ModalStackContext = createContext<ModalStackApi | null>(null);

/** Opens and closes modals imperatively. Needs a `ModalStack` above it. */
export function useModalStack(): ModalStackApi {
    const api = useContext(ModalStackContext);
    if (!api) throw new Error("useModalStack must be used inside <ModalStack>.");
    return api;
}
