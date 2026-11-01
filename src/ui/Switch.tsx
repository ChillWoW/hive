import type { ComponentProps } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "@/lib/cn";

export interface SwitchProps extends Omit<ComponentProps<typeof BaseSwitch.Root>, "className"> {
    className?: string;
}

export function Switch({ className, ...props }: SwitchProps) {
    return (
        <BaseSwitch.Root
            nativeButton
            render={<button type="button" />}
            className={cn(
                "group relative inline-flex h-5 w-9 shrink-0 items-center rounded-md",
                "border border-dark-500 bg-dark-700",
                "transition-colors duration-150 ease-out",
                "hover:border-dark-400",
                "data-[checked]:border-primary-100 data-[checked]:bg-primary-100",
                "data-[checked]:hover:bg-primary-200",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-dark-250 focus-visible:outline-offset-2",
                "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                "disabled:cursor-not-allowed disabled:opacity-50",
                className
            )}
            {...props}
        >
            <BaseSwitch.Thumb
                className={cn(
                    "block size-3 translate-x-[3px] rounded-sm bg-dark-50 shadow-sm",
                    "transition-all duration-200 ease-out",
                    "data-[checked]:translate-x-[19px] data-[checked]:bg-dark-950"
                )}
            />
        </BaseSwitch.Root>
    );
}
