import type { ComponentProps } from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/cn";

// Padding and text size follow the Input size scale.
const sizes = {
    xs: "px-2 py-1 text-xs",
    sm: "px-2.5 py-1.5 text-xs",
    md: "px-3 py-2 text-[13px]",
    lg: "px-3.5 py-2 text-sm",
    xl: "px-4 py-2.5 text-base",
} as const;

export type TextareaSize = keyof typeof sizes;

export interface TextareaProps
    extends Omit<ComponentProps<"textarea">, "className" | "defaultValue" | "value"> {
    size?: TextareaSize;
    /** Grow with the content (CSS `field-sizing: content`) instead of a manual resize handle. */
    autoResize?: boolean;
    className?: InputPrimitive.Props["className"];
    defaultValue?: string;
    value?: string;
    onValueChange?: InputPrimitive.Props["onValueChange"];
}

/** Multi-line text control. Renders a `<textarea>` that works with `Field` like `Input`. */
export function Textarea({ size = "sm", autoResize = false, className, ...props }: TextareaProps) {
    return (
        <InputPrimitive
            data-slot="textarea"
            render={<textarea />}
            className={(state) =>
                cn(
                    "field-sizing-fixed min-h-16 w-full min-w-0 rounded-md border border-border bg-transparent text-text outline-none transition-[border-color] duration-150 ease-out",
                    "placeholder:text-muted selection:bg-accent selection:text-accent-fg",
                    "focus-visible:border-muted",
                    "aria-invalid:border-danger aria-invalid:focus-visible:border-danger",
                    "data-invalid:border-danger data-invalid:focus-visible:border-danger",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    autoResize ? "field-sizing-content resize-none" : "resize-y",
                    sizes[size],
                    typeof className === "function" ? className(state) : className,
                )
            }
            // Base UI types its control as an <input>; at runtime the props land on the <textarea>.
            {...(props as unknown as Omit<InputPrimitive.Props, "className">)}
        />
    );
}
