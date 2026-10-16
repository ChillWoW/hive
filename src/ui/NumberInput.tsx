import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// Surface matches Select.Trigger — one bordered shell, transparent field inside.
const wrapperBaseClassName = cn(
    "inline-flex w-full items-center rounded-sm",
    "bg-dark-700 text-dark-50 border border-dark-500",
    "transition-[background-color,border-color,color]",
    "hover:border-dark-400",
    "focus-within:border-dark-400",
    "data-[invalid]:border-danger",
    "data-[invalid]:focus-within:border-danger",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

const adornmentClassName = cn(
    "inline-flex shrink-0 items-center justify-center text-dark-200"
);

type BaseInputProps = ComponentProps<typeof BaseInput>;

export interface NumberInputProps extends Omit<
    BaseInputProps,
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
    value?: number | null;
    defaultValue?: number | null;
    onValueChange?: (value: number | null) => void;
    min?: number;
    max?: number;
    step?: number;
    decimalPlaces?: number;
    allowNegative?: boolean;
    leftIcon?: ReactNode;
    rightIcon?: ReactNode;
    prefix?: ReactNode;
    suffix?: ReactNode;
    invalid?: boolean;
    className?: string;
    wrapperClassName?: string;
    onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

function buildPattern(
    allowNegative: boolean,
    decimalPlaces: number | undefined
): RegExp {
    const sign = allowNegative ? "-?" : "";

    if (decimalPlaces === 0) {
        return new RegExp(`^${sign}\\d*$`);
    }

    if (decimalPlaces == null) {
        return new RegExp(`^${sign}\\d*\\.?\\d*$`);
    }

    return new RegExp(`^${sign}\\d*\\.?\\d{0,${decimalPlaces}}$`);
}

function formatNumber(
    value: number | null | undefined,
    decimalPlaces: number | undefined
): string {
    if (value == null || Number.isNaN(value)) return "";

    if (decimalPlaces == null) {
        return String(value);
    }

    return value.toFixed(decimalPlaces);
}

function clamp(
    value: number,
    min: number | undefined,
    max: number | undefined
): number {
    let next = value;

    if (min != null && next < min) {
        next = min;
    }

    if (max != null && next > max) {
        next = max;
    }

    return next;
}

function isPartial(text: string): boolean {
    return text === "" || text === "-" || text === "." || text === "-.";
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
    (
        {
            size = "md",
            align = "left",
            value,
            defaultValue,
            onValueChange,
            min,
            max,
            step = 1,
            decimalPlaces,
            allowNegative = false,
            leftIcon,
            rightIcon,
            prefix,
            suffix,
            invalid,
            disabled,
            placeholder,
            className,
            wrapperClassName,
            onBlur,
            onKeyDown,
            ...props
        },
        ref
    ) => {
        const isControlled = value !== undefined;

        const [internalValue, setInternalValue] = useState<string>(() =>
            formatNumber(
                isControlled ? (value ?? null) : (defaultValue ?? null),
                decimalPlaces
            )
        );

        const lastEmittedRef = useRef<number | null>(
            isControlled ? (value ?? null) : (defaultValue ?? null)
        );

        useEffect(() => {
            if (!isControlled) return;

            const next = value ?? null;

            if (next === lastEmittedRef.current) {
                return;
            }

            lastEmittedRef.current = next;
            setInternalValue(formatNumber(next, decimalPlaces));
        }, [value, isControlled, decimalPlaces]);

        const pattern = useMemo(
            () => buildPattern(allowNegative, decimalPlaces),
            [allowNegative, decimalPlaces]
        );

        const emit = useCallback(
            (parsed: number | null) => {
                lastEmittedRef.current = parsed;
                onValueChange?.(parsed);
            },
            [onValueChange]
        );

        const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
            const next = event.target.value;

            if (isPartial(next)) {
                setInternalValue(next);

                if (lastEmittedRef.current !== null) {
                    emit(null);
                }

                return;
            }

            if (!pattern.test(next)) {
                return;
            }

            setInternalValue(next);

            const parsed = Number.parseFloat(next);

            if (Number.isNaN(parsed)) {
                if (lastEmittedRef.current !== null) {
                    emit(null);
                }

                return;
            }

            if (parsed !== lastEmittedRef.current) {
                emit(parsed);
            }
        };

        const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
            if (isPartial(internalValue)) {
                setInternalValue("");

                if (lastEmittedRef.current !== null) {
                    emit(null);
                }
            } else {
                const parsed = Number.parseFloat(internalValue);

                if (!Number.isNaN(parsed)) {
                    const clamped = clamp(parsed, min, max);

                    setInternalValue(formatNumber(clamped, decimalPlaces));

                    if (clamped !== lastEmittedRef.current) {
                        emit(clamped);
                    }
                }
            }

            onBlur?.(event);
        };

        const handleKeyDown = (
            event: KeyboardEvent<HTMLInputElement>
        ) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();

                const direction = event.key === "ArrowUp" ? 1 : -1;

                const current = Number.parseFloat(internalValue);

                const baseValue = Number.isNaN(current) ? 0 : current;

                const stepped = clamp(baseValue + direction * step, min, max);

                setInternalValue(formatNumber(stepped, decimalPlaces));

                if (stepped !== lastEmittedRef.current) {
                    emit(stepped);
                }
            }

            onKeyDown?.(event);
        };

        return (
            <div
                data-disabled={disabled || undefined}
                data-invalid={invalid || undefined}
                className={cn(
                    wrapperBaseClassName,
                    wrapperSizeStyles[size],
                    wrapperClassName
                )}
            >
                {leftIcon && (
                    <span
                        className={cn("-ml-0.5", adornmentClassName)}
                        aria-hidden
                    >
                        {leftIcon}
                    </span>
                )}

                {prefix && (
                    <span
                        className={cn("-ml-0.5 select-none", adornmentClassName)}
                        aria-hidden
                    >
                        {prefix}
                    </span>
                )}

                <BaseInput
                    ref={ref}
                    type="text"
                    inputMode={
                        decimalPlaces === 0 ? "numeric" : "decimal"
                    }
                    disabled={disabled}
                    placeholder={placeholder}
                    aria-invalid={invalid || undefined}
                    value={internalValue}
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
                        className={cn("-mr-0.5 select-none", adornmentClassName)}
                        aria-hidden
                    >
                        {suffix}
                    </span>
                )}

                {rightIcon && (
                    <span
                        className={cn("-mr-0.5", adornmentClassName)}
                        aria-hidden
                    >
                        {rightIcon}
                    </span>
                )}
            </div>
        );
    }
);

NumberInput.displayName = "NumberInput";
