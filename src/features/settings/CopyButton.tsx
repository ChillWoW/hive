import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button } from "@/ui";
import { useCopy } from "@/lib/clipboard";

/** Copies `text`; the icon turns into a check for a moment. */
export function CopyButton({ text, label = "Copy path" }: { text: string; label?: string }) {
    const [copied, copy] = useCopy();

    return (
        <Button
            size="sm"
            variant="ghost"
            aria-label={label}
            className="w-6 shrink-0 px-0"
            onClick={() => copy(text)}
        >
            {copied ? (
                <CheckIcon className="size-3.5" weight="bold" />
            ) : (
                <CopyIcon className="size-3.5" />
            )}
        </Button>
    );
}
