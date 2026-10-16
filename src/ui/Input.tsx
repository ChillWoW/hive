import { createContext, forwardRef, useContext, useId } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";

const wrapperSizeStyles: Record<Size, string> = {
    sm: "h-6 gap-1 px-2 text-xs",
    md: "h-8 gap-2 px-2.5 text-sm",
    lg: "h-10 gap-2.5 px-3 text-sm"
};

const inputSizeStyles: Record<Size, string> = {
    sm: "h-6 px-2 text-xs",
    md: "h-8 px-2.5 text-sm",
    lg: "h-10 px-3 text-sm"
};

type BaseInputProps = ComponentProps<typeof BaseInput>;

type InputFieldContextValue = {
    id: string;
    size: Size;
    invalid?: boolean;
    disabled?: boolean;
};

const InputFieldContext = createContext<InputFieldContextValue | null>(
    null
);

export interface InputRootProps extends ComponentProps<"div"> {
    size?: Size;
    invalid?: boolean;
    disabled?: boolean;
}

const InputRoot = forwardRef<HTMLDivElement, InputRootProps>(
    (
        { size = "md", invalid, disabled, className, children, ...props },
        ref
    ) => {
        const id = useId();

        return (
            <InputFieldContext.Provider value={{ id, size, invalid, disabled }}>
                <div
                    ref={ref}
                    className={cn("flex w-full flex-col gap-1.5", className)}
                    {...props}
                >
                    {children}
                </div>
            </InputFieldContext.Provider>
        );
    }
);
InputRoot.displayName = "Input.Root";

export interface InputLabelProps
    extends Omit<ComponentProps<"label">, "className"> {
    className?: string;
}

const InputLabel = forwardRef<HTMLLabelElement, InputLabelProps>(
    ({ className, htmlFor, ...props }, ref) => {
        const field = useContext(InputFieldContext);

        return (
            <label
                ref={ref}
                htmlFor={htmlFor ?? field?.id}
                className={cn(
                    "block text-xs font-medium text-dark-100 select-none",
                    field?.disabled && "opacity-50",
                    className
                )}
                {...props}
            />
        );
    }
);
InputLabel.displayName = "Input.Label";

export interface InputProps extends Omit<BaseInputProps, "className" | "size"> {
    size?: Size;
    leftIcon?: ReactNode;
    rightIcon?: ReactNode;
    invalid?: boolean;
    className?: string;
    wrapperClassName?: string;
}

const baseSurface = [
    "bg-dark-700 text-dark-50",
    "border border-dark-500",
    "transition-[background-color,border-color,color]",
    "hover:border-dark-400",
    "data-[invalid]:border-danger aria-invalid:border-danger",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    "disabled:pointer-events-none disabled:opacity-50"
].join(" ");

const InputControl = forwardRef<HTMLInputElement, InputProps>(
    (
        {
            size: sizeProp,
            leftIcon,
            rightIcon,
            invalid: invalidProp,
            disabled: disabledProp,
            id: idProp,
            className,
            wrapperClassName,
            ...props
        },
        ref
    ) => {
        const field = useContext(InputFieldContext);
        const size = sizeProp ?? field?.size ?? "md";
        const invalid = invalidProp ?? field?.invalid;
        const disabled = disabledProp ?? field?.disabled;
        const id = idProp ?? field?.id;

        if (leftIcon || rightIcon) {
            return (
                <div
                    data-disabled={disabled || undefined}
                    data-invalid={invalid || undefined}
                    className={cn(
                        "group relative inline-flex w-full items-center rounded-sm",
                        baseSurface,
                        "focus-within:border-dark-400",
                        "data-[invalid]:focus-within:border-danger",
                        wrapperSizeStyles[size],
                        wrapperClassName
                    )}
                >
                    {leftIcon && (
                        <span
                            className="-ml-0.5 inline-flex shrink-0 items-center justify-center text-dark-200"
                            aria-hidden
                        >
                            {leftIcon}
                        </span>
                    )}
                    <BaseInput
                        ref={ref}
                        id={id}
                        disabled={disabled}
                        aria-invalid={invalid || undefined}
                        className={cn(
                            "min-w-0 flex-1 bg-transparent text-dark-50 outline-none",
                            "placeholder:text-dark-200",
                            "disabled:cursor-not-allowed",
                            className
                        )}
                        {...props}
                    />
                    {rightIcon && (
                        <span className="-mr-0.5 inline-flex shrink-0 items-center justify-center text-dark-200">
                            {rightIcon}
                        </span>
                    )}
                </div>
            );
        }

        return (
            <BaseInput
                ref={ref}
                id={id}
                disabled={disabled}
                aria-invalid={invalid || undefined}
                className={cn(
                    "block w-full rounded-sm",
                    baseSurface,
                    "placeholder:text-dark-200",
                    "focus:border-dark-400 data-[focused]:border-dark-400",
                    "data-[invalid]:focus:border-danger",
                    "disabled:cursor-not-allowed",
                    inputSizeStyles[size],
                    className
                )}
                {...props}
            />
        );
    }
);

InputControl.displayName = "Input";

export const Input = Object.assign(InputControl, {
    Root: InputRoot,
    Label: InputLabel
});
