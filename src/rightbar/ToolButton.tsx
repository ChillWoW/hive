import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { iconButtonClassName, Tooltip } from "@/ui";

/** An icon button in a tab's toolbar, its label as a tooltip; `pressed` for a toggle. */
export function ToolButton({
    label,
    pressed,
    disabled,
    onClick,
    children
}: {
    label: string;
    pressed?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label={label}
                        aria-pressed={pressed}
                        disabled={disabled}
                        onClick={onClick}
                        className={cn(iconButtonClassName, pressed && "bg-white/10 text-dark-50")}
                    >
                        {children}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{label}</Tooltip.Content>
        </Tooltip>
    );
}
