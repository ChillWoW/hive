import { createContext, forwardRef, useCallback, useContext, useMemo } from "react";
import type { ComponentProps, Ref } from "react";
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

type BaseToggleGroupProps = ComponentProps<typeof BaseToggleGroup>;

export interface SegmentedControlProps
    extends Omit<
        BaseToggleGroupProps,
        "className" | "value" | "defaultValue" | "onValueChange" | "multiple"
    > {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    size?: Size;
    className?: string;
}

const SegmentedControlRoot = forwardRef<
    HTMLDivElement,
    SegmentedControlProps
>(
    (
        {
            size = "md",
            value,
            defaultValue,
            onValueChange,
            className,
            ...props
        },
        ref
    ) => {
        const groupValue = useMemo(
            () => (value !== undefined ? [value] : undefined),
            [value]
        );
        const groupDefaultValue = useMemo(
            () => (defaultValue !== undefined ? [defaultValue] : undefined),
            [defaultValue]
        );

        const handleValueChange = useCallback(
            (next: string[]) => {
                const selected = next[next.length - 1];
                if (selected === undefined) return;
                onValueChange?.(selected);
            },
            [onValueChange]
        );

        return (
            <SegmentedControlSizeContext.Provider value={size}>
                <BaseToggleGroup
                    ref={ref}
                    value={groupValue}
                    defaultValue={groupDefaultValue}
                    onValueChange={handleValueChange}
                    className={cn(
                        "inline-flex select-none items-stretch rounded-sm",
                        "border border-dark-500 bg-dark-700",
                        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                        rootSizeStyles[size],
                        className
                    )}
                    {...props}
                />
            </SegmentedControlSizeContext.Provider>
        );
    }
);

SegmentedControlRoot.displayName = "SegmentedControl";

type BaseToggleProps = ComponentProps<typeof BaseToggle>;

export interface SegmentedControlItemProps
    extends Omit<BaseToggleProps, "className"> {
    size?: Size;
    className?: string;
}

const SegmentedControlItem = forwardRef<
    HTMLButtonElement,
    SegmentedControlItemProps
>(({ size: sizeProp, className, disabled, ...props }, ref) => {
    const contextSize = useContext(SegmentedControlSizeContext);
    const size = sizeProp ?? contextSize;

    return (
        <BaseToggle
            ref={ref as Ref<HTMLButtonElement>}
            nativeButton
            render={<button type="button" />}
            disabled={disabled}
            className={cn(
                "relative inline-flex min-w-0 shrink-0 items-center justify-center rounded-xs",
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
});

SegmentedControlItem.displayName = "SegmentedControl.Item";

export const SegmentedControl = Object.assign(SegmentedControlRoot, {
    Item: SegmentedControlItem
});
