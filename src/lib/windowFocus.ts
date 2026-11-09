/**
 * Calls `listener` each time the window comes back into focus; returns the
 * unsubscribe, so an effect can `return onWindowFocus(refresh)`.
 */
export function onWindowFocus(listener: () => void): () => void {
    window.addEventListener("focus", listener);
    return () => window.removeEventListener("focus", listener);
}
