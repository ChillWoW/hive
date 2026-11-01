import { createContext, useContext } from "react";
import type { ComponentProps } from "react";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";

const SegmentedControlSizeContext = createContext<Size>("md");

const rootSizeStyles: Record<Size, string> = {
    sm: "h-6 p-0.5 gap-0.5",
    md: "h-8 p-1 gap-1",
    lg: "h-10 p-1 gap-1"
};

const itemSizeStyles: Record<Size, string> = {
    sm: "gap-1 px-2 text-xs",
    md: "gap-1.5 px-2.5 text-sm",
    lg: "gap-2 px-3 text-sm"
};

export interface SegmentedControlProps
    extends Omit<
        ComponentProps<typeof BaseToggleGroup>,
        "className" | "value" | "defaultValue" | "onValueChange" | "multiple"
    > {
    value?: string;
    onValueChange?: (value: string) => void;
    size?: Size;
    className?: string;
}

/** A single-choice toggle group: one item always pressed (pressing it again keeps it). */
function SegmentedControlRoot({
    size = "md",
    value,
    onValueChange,
    className,
    ...props
}: SegmentedControlProps) {
    return (
        <SegmentedControlSizeContext value={size}>
            <BaseToggleGroup
                value={value !== undefined ? [value] : undefined}
                onValueChange={(next: string[]) => {
                    const selected = next[next.length - 1];
                    if (selected !== undefined) onValueChange?.(selected);
                }}
                className={cn(
                    "inline-flex select-none items-stretch rounded-md",
                    "border border-dark-500 bg-dark-700",
                    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                    rootSizeStyles[size],
                    className
                )}
                {...props}
            />
        </SegmentedControlSizeContext>
    );
}

interface SegmentedControlItemProps
    extends Omit<ComponentProps<typeof BaseToggle>, "className"> {
    className?: string;
}

function SegmentedControlItem({ className, ...props }: SegmentedControlItemProps) {
    const size = useContext(SegmentedControlSizeContext);

    return (
        <BaseToggle
            nativeButton
            render={<button type="button" />}
            className={cn(
                "relative inline-flex min-w-0 shrink-0 items-center justify-center rounded-sm",
                "font-medium whitespace-nowrap text-dark-200",
                "transition-[background-color,color,box-shadow,transform]",
                "hover:text-dark-50 active:scale-[0.98]",
                "data-[pressed]:bg-dark-500 data-[pressed]:text-dark-50 data-[pressed]:shadow-sm data-[pressed]:shadow-black/10",
                "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[disabled]:active:scale-100",
                "disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100",
                itemSizeStyles[size],
                className
            )}
            {...props}
        />
    );
}

export const SegmentedControl = Object.assign(SegmentedControlRoot, {
    Item: SegmentedControlItem
});
