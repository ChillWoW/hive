import { cn } from "@/lib/cn";

export function SegmentedControl<T extends string>({
    value,
    options,
    onChange,
    "aria-label": ariaLabel
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (value: T) => void;
    "aria-label"?: string;
}) {
    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className="inline-flex rounded-md bg-bg p-0.5"
        >
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={option.value === value}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                        option.value === value
                            ? "bg-hover text-text"
                            : "text-muted hover:text-text"
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
