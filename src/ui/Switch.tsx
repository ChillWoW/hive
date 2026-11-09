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
                "group relative inline-flex h-4 w-7 shrink-0 items-center rounded-[4px]",
                "bg-border",
                "transition-colors duration-150 ease-out",
                "hover:bg-muted/40",
                "data-[checked]:bg-accent",
                "data-[checked]:hover:bg-accent/90",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-muted focus-visible:outline-offset-2",
                "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                "disabled:cursor-not-allowed disabled:opacity-50",
                className
            )}
            {...props}
        >
            <BaseSwitch.Thumb
                className={cn(
                    "block size-3 translate-x-[2px] rounded-[3px] bg-text shadow-sm",
                    "transition-[translate,background-color] duration-200 ease-out",
                    "data-[checked]:translate-x-[14px] data-[checked]:bg-accent-fg"
                )}
            />
        </BaseSwitch.Root>
    );
}
