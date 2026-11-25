import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "@/lib/cn";

export interface SeparatorProps extends SeparatorPrimitive.Props {}

/**
 * Divider line (Base UI's `Separator`, `role="separator"`). Horizontal by default and fills
 * the width; `orientation="vertical"` stretches to the height of its flex parent.
 * Children render as a centered label between two lines (horizontal only). The label is
 * presentational to screen readers; pass `aria-label` if it carries meaning.
 */
export function Separator({ orientation = "horizontal", className, children, ...props }: SeparatorProps) {
    const labeled = children != null && orientation === "horizontal";

    return (
        <SeparatorPrimitive
            data-slot="separator"
            orientation={orientation}
            className={(state) =>
                cn(
                    "shrink-0",
                    labeled
                        ? "flex w-full items-center gap-3 text-xs text-muted before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
                        : orientation === "vertical"
                          ? "w-px self-stretch bg-border"
                          : "h-px w-full bg-border",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            {labeled ? children : null}
        </SeparatorPrimitive>
    );
}
