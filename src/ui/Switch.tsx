import { cn } from "@/lib/cn";

export function Switch({
    checked,
    onCheckedChange,
    disabled,
    "aria-label": ariaLabel
}: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    "aria-label"?: string;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => onCheckedChange(!checked)}
            className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
                checked ? "bg-accent" : "bg-border"
            )}
        >
            <span
                className={cn(
                    "size-4 rounded-full shadow transition-transform",
                    checked ? "translate-x-4.5 bg-accent-fg" : "translate-x-0.5 bg-muted"
                )}
            />
        </button>
    );
}
