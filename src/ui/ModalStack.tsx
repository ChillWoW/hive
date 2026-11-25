import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { ModalStackContext, type ModalStackApi, type ModalStackItem } from "./useModalStack";

interface Entry extends ModalStackItem {
    id: string;
    open: boolean;
}

let nextId = 0;

/**
 * Hosts modals opened imperatively with `useModalStack()`. Wrap the app once. Each `open()` pushes
 * a modal on top; it renders nested inside the one below, so lower modals shrink and dim, and
 * Escape or an outside click closes only the top one.
 */
export function ModalStack({ children }: { children?: ReactNode }) {
    const [entries, setEntries] = useState<Entry[]>([]);
    // Source of truth for the callbacks, so back-to-back calls in one tick see each other's changes.
    const entriesRef = useRef(entries);

    const update = useCallback((next: Entry[]) => {
        entriesRef.current = next;
        setEntries(next);
    }, []);

    const open = useCallback(
        (item: ModalStackItem) => {
            const id = `modal-stack-${++nextId}`;
            update([...entriesRef.current, { ...item, id, open: true }]);
            return id;
        },
        [update],
    );

    // Marks the modal at `index` and everything above it as closing; each is removed once its
    // exit animation ends.
    const closeFrom = useCallback(
        (index: number) => {
            const current = entriesRef.current;
            if (index < 0 || !current.slice(index).some((e) => e.open)) return;
            for (const entry of current.slice(index)) if (entry.open) entry.onClose?.();
            update(current.map((e, i) => (i >= index ? { ...e, open: false } : e)));
        },
        [update],
    );

    const close = useCallback(
        (id?: string) => {
            const current = entriesRef.current;
            closeFrom(id ? current.findIndex((e) => e.id === id) : current.findLastIndex((e) => e.open));
        },
        [closeFrom],
    );

    const closeAll = useCallback(() => closeFrom(0), [closeFrom]);

    const remove = useCallback(
        (id: string) => {
            const index = entriesRef.current.findIndex((e) => e.id === id);
            if (index >= 0) update(entriesRef.current.slice(0, index));
        },
        [update],
    );

    const count = entries.filter((e) => e.open).length;
    const api = useMemo<ModalStackApi>(() => ({ open, close, closeAll, count }), [open, close, closeAll, count]);

    return (
        <ModalStackContext.Provider value={api}>
            {children}
            <StackLevel entries={entries} index={0} close={close} remove={remove} />
        </ModalStackContext.Provider>
    );
}

interface StackLevelProps {
    entries: Entry[];
    index: number;
    close: (id: string) => void;
    remove: (id: string) => void;
}

/** One modal of the stack, with the next level rendered inside its popup so Base UI treats it as nested. */
function StackLevel({ entries, index, close, remove }: StackLevelProps) {
    const entry = entries[index];
    if (!entry) return null;
    const { id, content, size, showCloseButton, disablePointerDismissal } = entry;

    return (
        <Modal
            open={entry.open}
            onOpenChange={(open) => !open && close(id)}
            onOpenChangeComplete={(open) => !open && remove(id)}
            disablePointerDismissal={disablePointerDismissal}
        >
            <Modal.Content size={size} showCloseButton={showCloseButton}>
                {typeof content === "function" ? content({ id, close: () => close(id) }) : content}
                <StackLevel entries={entries} index={index + 1} close={close} remove={remove} />
            </Modal.Content>
        </Modal>
    );
}
