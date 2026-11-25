import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

function withBase<State>(base: string, className: ClassName<State>) {
    return (state: State) => cn(base, typeof className === "function" ? className(state) : className);
}

/**
 * Section that shows and hides its content (Base UI's `Collapsible`). Compose with
 * `Collapsible.Trigger` and `Collapsible.Panel`. Control it with `open`/`onOpenChange`,
 * or start it open with `defaultOpen`.
 */
export function Collapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
    return <CollapsiblePrimitive.Root data-slot="collapsible" className={withBase("flex flex-col", className)} {...props} />;
}

export interface CollapsibleTriggerProps extends CollapsiblePrimitive.Trigger.Props {
    /** Renders a caret after the label that flips when open. Default `true`. */
    showIcon?: boolean;
}

/** Button that toggles the panel. Use `render={<Button />}` for a styled button. */
function CollapsibleTrigger({ showIcon = true, className, children, ...props }: CollapsibleTriggerProps) {
    return (
        <CollapsiblePrimitive.Trigger
            data-slot="collapsible-trigger"
            className={withBase(
                cn(
                    "group/collapsible inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-sm font-medium text-text outline-none",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                ),
                className,
            )}
            {...props}
        >
            {children}
            {showIcon && (
                <CaretDownIcon
                    className={cn(
                        "size-3.5 shrink-0 text-muted transition-transform duration-200 ease-out motion-reduce:transition-none",
                        "group-data-panel-open/collapsible:rotate-180",
                    )}
                />
            )}
        </CollapsiblePrimitive.Trigger>
    );
}

/**
 * The content. Animates its height open and closed. `keepMounted` keeps it in the DOM
 * while closed; `hiddenUntilFound` also lets the browser's find-in-page reveal it.
 */
function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
    return (
        <CollapsiblePrimitive.Panel
            data-slot="collapsible-panel"
            className={withBase(
                cn(
                    "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none",
                    "data-starting-style:h-0 data-ending-style:h-0",
                ),
                className,
            )}
            {...props}
        />
    );
}

Collapsible.Trigger = CollapsibleTrigger;
Collapsible.Panel = CollapsiblePanel;
