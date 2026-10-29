import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { attachSession } from "./sessions";

/**
 * Tab `id`'s terminal (it outlives this component, so scrollback and the
 * shell come back with the tab).
 */
export function TerminalView({ id }: { id: string }) {
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = host.current;
        if (!el) return;
        return attachSession(id, el);
    }, [id]);

    // Padding here, not on the terminal's own element, so fitting counts it.
    return (
        <div className="min-h-0 flex-1 overflow-hidden bg-dark-850 py-1.5 pl-3">
            <div ref={host} className="h-full w-full" />
        </div>
    );
}
