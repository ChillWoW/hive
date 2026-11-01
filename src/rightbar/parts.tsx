import type { ReactNode } from "react";
import { ShortcutKeys, useBinding, type ActionId } from "@/keybindings";
import { cn } from "@/lib/cn";
import { DotMatrixSpinner, IconButton } from "@/ui";
import type { IconButtonProps } from "@/ui/IconButton";

/** An icon button in a tab's toolbar, its label as a tooltip; `pressed` for a toggle. */
export function ToolButton({ pressed, className, ...props }: IconButtonProps & { pressed?: boolean }) {
    return (
        <IconButton
            aria-pressed={pressed}
            className={cn(pressed && "bg-white/10 text-dark-50", className)}
            {...props}
        />
    );
}

/** A tab's toolbar row. */
export function TabToolbar({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-dark-600 px-2">
            {children}
        </div>
    );
}

/** A line in place of a tab's content: why there's nothing (or a failure, in `warning`). */
export function Notice({ children, tone }: { children: ReactNode; tone?: "warning" }) {
    return (
        <div
            className={cn(
                "flex flex-1 items-center justify-center p-6 text-center text-xs",
                tone === "warning" ? "text-warning/85" : "text-dark-250"
            )}
        >
            {children}
        </div>
    );
}

/** A spinner in place of a tab's content while it's read. */
export function Loading({ label }: { label: string }) {
    return (
        <div className="flex flex-1 items-center justify-center">
            <DotMatrixSpinner label={label} />
        </div>
    );
}

/** An action's current shortcut as plain text (nothing while unbound). */
export function ActionKeys({ id, className }: { id: ActionId; className?: string }) {
    return <ShortcutKeys shortcut={useBinding(id)} variant="plain" className={className} />;
}
