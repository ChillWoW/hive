import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ComponentProps, FocusEvent, KeyboardEvent, ReactNode } from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";
type Align = "left" | "center" | "right";

const wrapperSizeStyles: Record<Size, string> = {
    sm: "h-6 gap-1 px-2 text-xs",
    md: "h-8 gap-2 px-2.5 text-sm",
    lg: "h-10 gap-2.5 px-3 text-sm"
};

const alignStyles: Record<Align, string> = {
    left: "text-left",
    center: "text-center",
    right: "text-right"
};

// Surface matches Input's — one bordered shell, transparent field inside.
const wrapperBaseClassName = cn(
    "inline-flex w-full items-center rounded-md",
    "bg-dark-700 text-dark-50 border border-dark-500",
    "transition-[background-color,border-color,color]",
    "hover:border-dark-400",
    "focus-within:border-dark-400",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

export interface NumberInputProps
    extends Omit<
        ComponentProps<typeof BaseInput>,
        | "className"
        | "size"
        | "type"
        | "value"
        | "defaultValue"
        | "onChange"
        | "prefix"
        | "onBlur"
        | "onKeyDown"
        | "onValueChange"
    > {
    size?: Size;
    align?: Align;
    value: number | null;
    onValueChange?: (value: number | null) => void;
    min?: number;
    max?: number;
    step?: number;
    decimalPlaces?: number;
    /** After the number, inside the border (a unit). */
    suffix?: ReactNode;
    className?: string;
    wrapperClassName?: string;
    onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

function buildPattern(decimalPlaces: number | undefined): RegExp {
    if (decimalPlaces === 0) return /^\d*$/;
    if (decimalPlaces == null) return /^\d*\.?\d*$/;
    return new RegExp(`^\\d*\\.?\\d{0,${decimalPlaces}}$`);
}

function formatNumber(value: number | null, decimalPlaces: number | undefined): string {
    if (value == null || Number.isNaN(value)) return "";
    return decimalPlaces == null ? String(value) : value.toFixed(decimalPlaces);
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
    if (min != null && value < min) return min;
    if (max != null && value > max) return max;
    return value;
}

const isPartial = (text: string) => text === "" || text === "-" || text === "." || text === "-.";

/**
 * A text field holding a non-negative number: typing is filtered to digits
 * (and `decimalPlaces` decimals), ↑/↓ step it, and leaving it clamps to
 * `min`/`max`. An empty or partial entry reports `null`.
 */
export function NumberInput({
    size = "md",
    align = "left",
    value,
    onValueChange,
    min,
    max,
    step = 1,
    decimalPlaces,
    suffix,
    disabled,
    className,
    wrapperClassName,
    onBlur,
    onKeyDown,
    ...props
}: NumberInputProps) {
    const [text, setText] = useState(() => formatNumber(value, decimalPlaces));
    const lastEmitted = useRef<number | null>(value);

    // A value changed from outside replaces the text; our own echo doesn't.
    useEffect(() => {
        if (value === lastEmitted.current) return;
        lastEmitted.current = value;
        setText(formatNumber(value, decimalPlaces));
    }, [value, decimalPlaces]);

    const emit = (next: number | null) => {
        if (next === lastEmitted.current) return;
        lastEmitted.current = next;
        onValueChange?.(next);
    };

    /** Shows `next` formatted and reports it. */
    const commit = (next: number) => {
        setText(formatNumber(next, decimalPlaces));
        emit(next);
    };

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
        const next = event.target.value;
        if (!isPartial(next) && !buildPattern(decimalPlaces).test(next)) return;
        setText(next);
        const parsed = Number.parseFloat(next);
        emit(Number.isNaN(parsed) ? null : parsed);
    };

    const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
        if (isPartial(text)) {
            setText("");
            emit(null);
        } else {
            const parsed = Number.parseFloat(text);
            if (!Number.isNaN(parsed)) commit(clamp(parsed, min, max));
        }
        onBlur?.(event);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const current = Number.parseFloat(text);
            const base = Number.isNaN(current) ? 0 : current;
            commit(clamp(base + (event.key === "ArrowUp" ? step : -step), min, max));
        }
        onKeyDown?.(event);
    };

    return (
        <div
            data-disabled={disabled || undefined}
            className={cn(wrapperBaseClassName, wrapperSizeStyles[size], wrapperClassName)}
        >
            <BaseInput
                type="text"
                inputMode={decimalPlaces === 0 ? "numeric" : "decimal"}
                disabled={disabled}
                value={text}
                onChange={handleChange}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className={cn(
                    "min-w-0 flex-1 bg-transparent tabular-nums text-dark-50 outline-none",
                    "placeholder:text-dark-200",
                    "disabled:cursor-not-allowed",
                    alignStyles[align],
                    className
                )}
                {...props}
            />
            {suffix && (
                <span
                    className="-mr-0.5 inline-flex shrink-0 items-center justify-center text-dark-200 select-none"
                    aria-hidden
                >
                    {suffix}
                </span>
            )}
        </div>
    );
}
