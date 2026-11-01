import type { ReactNode } from "react";
import type { ActionId } from "@/keybindings";
import { Button, Tooltip } from "@/ui";

/** An icon button in the top bar, its label (and `shortcut`'s binding) as a tooltip below it. */
export function BarButton({
    label,
    tooltip = label,
    shortcut,
    onClick,
    disabled,
    pressed,
    children
}: {
    /** The accessible name, and the tooltip unless `tooltip` says otherwise. */
    label: string;
    tooltip?: ReactNode;
    shortcut: ActionId;
    onClick: () => void;
    disabled?: boolean;
    /** Marks a toggle (`aria-pressed`). */
    pressed?: boolean;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <Button
                        variant="ghost"
                        onClick={onClick}
                        disabled={disabled}
                        aria-label={label}
                        aria-pressed={pressed}
                        className="p-0 size-6"
                    >
                        {children}
                    </Button>
                }
            />
            <Tooltip.Content side="bottom" shortcut={shortcut}>
                {tooltip}
            </Tooltip.Content>
        </Tooltip>
    );
}
