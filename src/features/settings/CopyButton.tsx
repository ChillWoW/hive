import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button } from "@/ui";
import { useCopy } from "@/lib/clipboard";

/** Copies `text`; the icon turns into a check for a moment. */
export function CopyButton({ text, label = "Copy path" }: { text: string; label?: string }) {
    const [copied, copy] = useCopy();

    return (
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={() => copy(text)}>
            {copied ? <CheckIcon weight="bold" /> : <CopyIcon />}
        </Button>
    );
}
