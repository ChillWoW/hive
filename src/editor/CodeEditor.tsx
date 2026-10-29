import { useEffect, useRef } from "react";
import { attachView, detachView } from "./documents";

/**
 * The CodeMirror editor of the tab `id` (its state outlives this component,
 * so undo history, selection and scroll come back with the tab).
 */
export function CodeEditor({ id }: { id: string }) {
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = host.current;
        if (!el) return;
        const view = attachView(id, el);
        if (!view) return;
        return () => detachView(id, view);
    }, [id]);

    return <div ref={host} className="min-h-0 flex-1 overflow-hidden" />;
}
