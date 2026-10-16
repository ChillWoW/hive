import { forwardRef } from "react";
import type { ComponentProps, Ref } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";

const rootSizeStyles: Record<Size, string> = {
    sm: "h-4 w-7",
    md: "h-5 w-9",
    lg: "h-6 w-11"
};

const thumbSizeStyles: Record<Size, string> = {
    sm: "size-2.5 translate-x-[2px] data-[checked]:translate-x-[14px]",
    md: "size-3 translate-x-[3px] data-[checked]:translate-x-[19px]",
    lg: "size-4 translate-x-[3px] data-[checked]:translate-x-[23px]"
};

type BaseSwitchRootProps = ComponentProps<typeof BaseSwitch.Root>;

export interface SwitchProps extends Omit<BaseSwitchRootProps, "className"> {
    size?: Size;
    className?: string;
    thumbClassName?: string;
}

const SwitchRoot = forwardRef<HTMLButtonElement, SwitchProps>(
    ({ size = "md", className, thumbClassName, disabled, ...props }, ref) => {
        return (
            <BaseSwitch.Root
                ref={ref as Ref<HTMLButtonElement>}
                nativeButton
                render={<button type="button" />}
                disabled={disabled}
                className={cn(
                    "group relative inline-flex shrink-0 items-center rounded-sm",
                    "border border-dark-500 bg-dark-700",
                    "transition-colors duration-150 ease-out",
                    "hover:border-dark-400",
                    "data-[checked]:border-primary-100 data-[checked]:bg-primary-100",
                    "data-[checked]:hover:bg-primary-200",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-dark-300 focus-visible:outline-offset-2",
                    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    rootSizeStyles[size],
                    className
                )}
                {...props}
            >
                <BaseSwitch.Thumb
                    className={cn(
                        "block rounded-xs bg-dark-50 shadow-sm",
                        "transition-all duration-200 ease-out",
                        "data-[checked]:bg-dark-950",
                        thumbSizeStyles[size],
                        thumbClassName
                    )}
                />
            </BaseSwitch.Root>
        );
    }
);

SwitchRoot.displayName = "Switch";

export const Switch = SwitchRoot;
