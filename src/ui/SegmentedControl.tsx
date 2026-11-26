import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { cn } from "@/lib/cn";

// Root heights match Button (28-44); items fill the root minus its 1px border and 2px padding.
const sizes = {
    xs: { root: "h-7", item: "gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5" },
    sm: { root: "h-8", item: "gap-1.5 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-4" },
    md: { root: "h-9", item: "gap-2 px-3 text-[13px] [&_svg:not([class*='size-'])]:size-4" },
    lg: { root: "h-10", item: "gap-2 px-4 text-sm [&_svg:not([class*='size-'])]:size-4.5" },
    xl: { root: "h-11", item: "gap-2 px-5 text-base [&_svg:not([class*='size-'])]:size-5" },
} as const;

export type SegmentedControlSize = keyof typeof sizes;

const SizeContext = createContext<SegmentedControlSize>("sm");

const ITEM_SELECTOR = ':scope > [data-slot="segmented-control-item"]';

/**
 * Keeps the indicator over the checked item. Base UI owns the checked state (controlled or
 * not), so this watches `data-checked` instead of the value. Selection changes slide the
 * indicator; resizes, the first paint and reappearing after nothing was checked snap it.
 */
function useIndicator() {
    const ref = useRef<HTMLSpanElement>(null);

    useLayoutEffect(() => {
        const indicator = ref.current;
        const root = indicator?.parentElement;
        if (!indicator || !root) return;

        let visible = false;

        const update = (animate: boolean) => {
            const item = root.querySelector<HTMLElement>(`${ITEM_SELECTOR}[data-checked]`);
            if (!item || root.offsetWidth === 0) {
                indicator.style.visibility = "hidden";
                visible = false;
                return;
            }

            // Rects include ancestor transforms (e.g. a modal's open scale); divide them out.
            const rootRect = root.getBoundingClientRect();
            const itemRect = item.getBoundingClientRect();
            // offsetWidth is rounded, so only treat a difference of a pixel or more as a transform.
            const scale = Math.abs(rootRect.width - root.offsetWidth) < 1 ? 1 : rootRect.width / root.offsetWidth;
            const x = (itemRect.left - rootRect.left) / scale - root.clientLeft;
            const y = (itemRect.top - rootRect.top) / scale - root.clientTop;

            const instant = !animate || !visible;
            if (instant) indicator.style.transition = "none";
            indicator.style.width = `${itemRect.width / scale}px`;
            indicator.style.height = `${itemRect.height / scale}px`;
            indicator.style.translate = `${x}px ${y}px`;
            indicator.style.visibility = "visible";
            if (instant) {
                void indicator.offsetWidth; // commit the jump before re-enabling the transition
                indicator.style.transition = "";
            }
            visible = true;
        };

        const resizeObserver = new ResizeObserver(() => update(false));
        const observeItems = () => {
            resizeObserver.observe(root);
            root.querySelectorAll(ITEM_SELECTOR).forEach((item) => resizeObserver.observe(item));
        };
        const mutationObserver = new MutationObserver((records) => {
            if (records.some((r) => r.type === "childList")) observeItems();
            update(true);
        });

        update(false);
        observeItems();
        mutationObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-checked"] });

        return () => {
            resizeObserver.disconnect();
            mutationObserver.disconnect();
        };
    }, []);

    return ref;
}

export interface SegmentedControlProps<Value = string> extends RadioGroup.Props<Value> {
    size?: SegmentedControlSize;
}

/**
 * Single-choice row of segments with a sliding indicator (Base UI's `RadioGroup`, so it
 * always holds one value, supports `name` for forms, and moves the selection with the arrow
 * keys). Control it with `value`/`onValueChange` or seed it with `defaultValue`; give it an
 * `aria-label`. Segments share the width evenly, so `className="w-full"` stretches them.
 */
export function SegmentedControl<Value = string>({ size = "sm", className, children, ...props }: SegmentedControlProps<Value>) {
    const indicatorRef = useIndicator();

    return (
        <SizeContext.Provider value={size}>
            <RadioGroup<Value>
                data-slot="segmented-control"
                className={(state) =>
                    cn(
                        "group/segmented-control relative isolate inline-flex w-fit items-stretch rounded-md border border-border bg-raised p-0.5",
                        sizes[size].root,
                        typeof className === "function" ? className(state) : className,
                    )
                }
                {...props}
            >
                <span
                    ref={indicatorRef}
                    aria-hidden
                    data-slot="segmented-control-indicator"
                    className={cn(
                        "pointer-events-none invisible absolute top-0 left-0 rounded-sm bg-border shadow-sm shadow-black/10",
                        "transition-[translate,width,height] duration-200 ease-out motion-reduce:transition-none",
                        // Disabled items dim themselves; a disabled group dims the indicator too.
                        "group-data-disabled/segmented-control:opacity-50",
                    )}
                />
                {children}
            </RadioGroup>
        </SizeContext.Provider>
    );
}

export interface SegmentedControlItemProps<Value = string> extends Radio.Root.Props<Value> {
    /** Square segment for a lone icon; pair it with an `aria-label`. */
    iconOnly?: boolean;
}

/** One segment. Needs a `value` unique within its `SegmentedControl`. */
function SegmentedControlItem<Value = string>({ iconOnly, className, ...props }: SegmentedControlItemProps<Value>) {
    const size = useContext(SizeContext);

    return (
        <Radio.Root<Value>
            data-slot="segmented-control-item"
            className={(state) =>
                cn(
                    "relative inline-flex flex-1 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-sm font-medium text-muted",
                    "transition-[color] duration-150 ease-out hover:text-text data-checked:text-text",
                    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                    "data-readonly:cursor-default data-readonly:hover:text-muted data-readonly:data-checked:hover:text-text",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:text-muted data-disabled:data-checked:hover:text-text",
                    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
                    sizes[size].item,
                    iconOnly && "aspect-square flex-none px-0",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

SegmentedControl.Item = SegmentedControlItem;
