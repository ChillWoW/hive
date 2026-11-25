import { createContext, use, type ComponentProps, type MouseEvent } from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/cn";

// Heights match Button sizes (28-44) so inputs and buttons line up in a row.
const sizes = {
    xs: "h-7 px-2 text-xs file:text-xs",
    sm: "h-8 px-2.5 text-sm file:text-sm",
    md: "h-9 px-3 text-sm file:text-sm",
    lg: "h-10 px-3.5 text-sm file:text-sm",
    xl: "h-11 px-4 text-base file:text-base",
} as const;

// Group: same height/padding as a lone input. The negative margin pulls a button
// in an edge addon toward the border so its inset roughly matches the vertical one.
const groupSizes = {
    xs: "h-7 gap-1.5 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5 [&>:first-child>button]:-ml-1.5 [&>:last-child>button]:-mr-1.5",
    sm: "h-8 gap-2 px-2.5 text-sm [&_svg:not([class*='size-'])]:size-4 [&>:first-child>button]:-ml-2 [&>:last-child>button]:-mr-2",
    md: "h-9 gap-2 px-3 text-sm [&_svg:not([class*='size-'])]:size-4 [&>:first-child>button]:-ml-2 [&>:last-child>button]:-mr-2",
    lg: "h-10 gap-2 px-3.5 text-sm [&_svg:not([class*='size-'])]:size-4.5 [&>:first-child>button]:-ml-2.5 [&>:last-child>button]:-mr-2.5",
    xl: "h-11 gap-2.5 px-4 text-base [&_svg:not([class*='size-'])]:size-5 [&>:first-child>button]:-ml-3 [&>:last-child>button]:-mr-3",
} as const;

export type InputSize = keyof typeof sizes;

const GroupContext = createContext<InputSize | null>(null);

// Native `size` (character width) is replaced by the visual size scale.
export interface InputProps extends Omit<InputPrimitive.Props, "size"> {
    /** Ignored inside `Input.Group`, which sets the size. */
    size?: InputSize;
}

export function Input({ size = "sm", className, ...props }: InputProps) {
    const groupSize = use(GroupContext);
    const grouped = groupSize !== null;

    return (
        <InputPrimitive
            data-slot="input"
            className={(state) =>
                cn(
                    "w-full min-w-0 rounded-md border border-border bg-transparent text-text outline-none transition-[border-color] duration-150 ease-out",
                    "placeholder:text-muted selection:bg-accent selection:text-accent-fg",
                    "focus-visible:border-muted",
                    "aria-invalid:border-danger aria-invalid:focus-visible:border-danger",
                    "data-invalid:border-danger data-invalid:focus-visible:border-danger",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    "file:mr-3 file:h-full file:border-0 file:bg-transparent file:font-medium file:text-text",
                    sizes[groupSize ?? size],
                    // The group draws the border, padding and disabled dimming.
                    grouped && "h-full flex-1 rounded-none border-0 px-0 data-disabled:opacity-100",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

export interface InputGroupProps extends ComponentProps<"div"> {
    size?: InputSize;
}

function InputGroup({ size = "sm", className, ...props }: InputGroupProps) {
    return (
        <GroupContext value={size}>
            <div
                data-slot="input-group"
                className={cn(
                    "flex w-full min-w-0 cursor-text items-center rounded-md border border-border text-text transition-[border-color] duration-150 ease-out",
                    "has-[[data-slot=input]:focus-visible]:border-muted",
                    "has-[[data-slot=input][aria-invalid=true]]:border-danger has-[[data-slot=input][data-invalid]]:border-danger",
                    "has-[[data-slot=input]:disabled]:cursor-not-allowed has-[[data-slot=input]:disabled]:opacity-50",
                    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
                    groupSizes[size],
                    className,
                )}
                {...props}
            />
        </GroupContext>
    );
}

export type InputAddonProps = ComponentProps<"div">;

/** Icon, text or button placed before or after the input in an `Input.Group`. */
function InputAddon({ className, onClick, ...props }: InputAddonProps) {
    // Clicking an icon or text addon focuses the input; buttons keep their own click.
    function handleClick(event: MouseEvent<HTMLDivElement>) {
        onClick?.(event);
        if (event.defaultPrevented || (event.target as HTMLElement).closest("button")) return;
        event.currentTarget.parentElement
            ?.querySelector<HTMLInputElement>("[data-slot=input]")
            ?.focus();
    }

    return (
        <div
            data-slot="input-addon"
            className={cn("flex shrink-0 select-none items-center gap-1.5 text-muted", className)}
            onClick={handleClick}
            {...props}
        />
    );
}

Input.Group = InputGroup;
Input.Addon = InputAddon;
