import { useEffect, useState } from "react";

/** Puts `text` on the clipboard; resolves whether it got there (never rejects). */
export function copyText(text: string): Promise<boolean> {
    return navigator.clipboard.writeText(text).then(
        () => true,
        () => false
    );
}

/**
 * Copies text to the clipboard; `copied` holds for `ms` after it lands, for a
 * ✓ or "Copied" in the button's place.
 */
export function useCopy(ms = 1500): [copied: boolean, copy: (text: string) => void] {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), ms);
        return () => clearTimeout(timer);
    }, [copied, ms]);
    return [copied, (text) => void copyText(text).then((ok) => ok && setCopied(true))];
}
