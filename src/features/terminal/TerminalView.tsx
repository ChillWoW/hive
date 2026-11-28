import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { reviveTerminal } from "./open";
import { attachSession } from "./sessions";

/**
 * Tab `id`'s terminal. The terminal outlives this view, so its scrollback
 * and shell are still there when the tab is shown again.
 */
export function TerminalView({ id }: { id: string }) {
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = host.current;
        if (!el) return;
        // A tab from before a restart has no terminal yet.
        reviveTerminal(id);
        return attachSession(id, el);
    }, [id]);

    // Padding here, not on the terminal's own element, so fitting counts it.
    return (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-bg py-1.5 pl-3">
            <div ref={host} className="h-full min-w-0 flex-1" />
        </div>
    );
}
