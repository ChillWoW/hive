import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button } from "@/ui";

/** Copies `text`; the icon turns into a check for a moment. */
export function CopyButton({ text, label = "Copy path" }: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    return (
        <Button
            size="sm"
            variant="ghost"
            aria-label={label}
            className="w-6 shrink-0 px-0"
            onClick={() =>
                navigator.clipboard.writeText(text).then(
                    () => setCopied(true),
                    () => {}
                )
            }
        >
            {copied ? (
                <CheckIcon className="size-3.5" weight="bold" />
            ) : (
                <CopyIcon className="size-3.5" />
            )}
        </Button>
    );
}
