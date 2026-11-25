import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/cn";

// `track` is the bar's thickness, `thumb` its diameter. The control pads the cross axis
// so the hit area is taller than the bar; Base UI subtracts that padding when mapping
// pointer positions, so it doesn't skew the value.
const sizes = {
    xs: { track: 1, thumb: "size-2.5", pad: 1.5 },
    sm: { track: 1, thumb: "size-3", pad: 2 },
    md: { track: 1.5, thumb: "size-4", pad: 2 },
    lg: { track: 1.5, thumb: "size-5", pad: 2.5 },
    xl: { track: 2, thumb: "size-6", pad: 3 },
} as const;

// Literal class names so Tailwind's scanner picks them up.
const trackThickness = {
    horizontal: { 1: "h-1", 1.5: "h-1.5", 2: "h-2" },
    vertical: { 1: "w-1", 1.5: "w-1.5", 2: "w-2" },
} as const;
const controlPad = {
    horizontal: { 1.5: "py-1.5", 2: "py-2", 2.5: "py-2.5", 3: "py-3" },
    vertical: { 1.5: "px-1.5", 2: "px-2", 2.5: "px-2.5", 3: "px-3" },
} as const;

export type SliderSize = keyof typeof sizes;

export interface SliderProps<Value extends number | readonly number[] = number | readonly number[]>
    extends SliderPrimitive.Root.Props<Value> {
    size?: SliderSize;
    /** Accessible name for each thumb; forwarded to the thumb inputs. */
    getAriaLabel?: (index: number) => string;
    /** Spoken value for each thumb, e.g. `"50 percent"`. */
    getAriaValueText?: (formattedValue: string, value: number, index: number) => string;
}

/**
 * Drag or use arrow keys to pick a value (Shift / Page Up/Down: `largeStep`). Pass an
 * array to `value`/`defaultValue` for a range with one thumb per entry. `children` render
 * above the control, e.g. `Slider.Label` and `Slider.Value`. Label it with `Slider.Label`,
 * `Field.Label`, `aria-label` (single thumb) or `getAriaLabel` (range).
 * Vertical sliders take their height from the root (`className="h-40"`).
 */
export function Slider<Value extends number | readonly number[]>({
    size = "md",
    orientation = "horizontal",
    thumbAlignment = "edge",
    "aria-label": ariaLabel,
    getAriaLabel,
    getAriaValueText,
    className,
    children,
    ...props
}: SliderProps<Value>) {
    const source = props.value ?? props.defaultValue;
    const thumbCount = Array.isArray(source) ? source.length : 1;
    const vertical = orientation === "vertical";
    const { track, thumb, pad } = sizes[size];

    return (
        <SliderPrimitive.Root
            data-slot="slider"
            orientation={orientation}
            thumbAlignment={thumbAlignment}
            className={(state) =>
                cn(
                    "flex min-w-0 flex-col gap-1.5",
                    vertical ? "h-40 w-fit items-center" : "w-full",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            {children}
            <SliderPrimitive.Control
                data-slot="slider-control"
                className={cn(
                    "flex touch-none select-none items-center",
                    "cursor-pointer data-disabled:cursor-not-allowed",
                    vertical ? "min-h-0 flex-1 justify-center" : "w-full",
                    controlPad[orientation][pad],
                )}
            >
                <SliderPrimitive.Track
                    data-slot="slider-track"
                    className={cn(
                        "relative rounded-full bg-hover",
                        vertical ? "h-full" : "w-full",
                        trackThickness[orientation][track],
                    )}
                >
                    <SliderPrimitive.Indicator
                        data-slot="slider-indicator"
                        className={cn(
                            "rounded-full bg-accent data-invalid:bg-danger",
                            vertical ? "w-full" : "h-full",
                        )}
                    />
                    {Array.from({ length: thumbCount }, (_, index) => (
                        <SliderPrimitive.Thumb
                            key={index}
                            index={index}
                            data-slot="slider-thumb"
                            aria-label={thumbCount === 1 ? ariaLabel : undefined}
                            getAriaLabel={getAriaLabel}
                            getAriaValueText={getAriaValueText}
                            className={cn(
                                "rounded-full bg-accent shadow-sm shadow-black/40",
                                "transition-[box-shadow] duration-150 ease-out motion-reduce:transition-none",
                                "cursor-grab hover:ring-4 hover:ring-accent/15 data-dragging:cursor-grabbing data-dragging:ring-4 data-dragging:ring-accent/25",
                                "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent",
                                "data-invalid:bg-danger data-invalid:hover:ring-danger/15",
                                "data-disabled:cursor-not-allowed data-disabled:hover:ring-0",
                                thumb,
                            )}
                        />
                    ))}
                </SliderPrimitive.Track>
            </SliderPrimitive.Control>
        </SliderPrimitive.Root>
    );
}

/** Associated with the thumbs automatically; put it in `Slider`'s children. */
function SliderLabel({ className, ...props }: SliderPrimitive.Label.Props) {
    return (
        <SliderPrimitive.Label
            data-slot="slider-label"
            className={(state) =>
                cn(
                    "w-fit select-none text-sm font-medium text-text",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

/**
 * The formatted value (ranges join with an en dash). Pass a function child
 * `(formatted, values) => ReactNode` to render it yourself.
 */
function SliderValue({ className, children, ...props }: SliderPrimitive.Value.Props) {
    return (
        <SliderPrimitive.Value
            data-slot="slider-value"
            className={(state) =>
                cn(
                    "text-sm tabular-nums text-muted",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            {children ?? ((formatted) => formatted.join(" – "))}
        </SliderPrimitive.Value>
    );
}

Slider.Label = SliderLabel;
Slider.Value = SliderValue;
