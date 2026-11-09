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
            className="inline-flex rounded-md bg-neutral-900 p-0.5"
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
                            ? "bg-neutral-700 text-neutral-50"
                            : "text-neutral-400 hover:text-neutral-200"
                    )}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
