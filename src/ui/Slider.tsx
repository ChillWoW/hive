import { createContext, forwardRef, useContext } from "react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";

/** Lets the parts pick up the root's size when they're composed by hand. */
const SliderSizeContext = createContext<Size>("md");

// The control is the hit area — taller than the track so the thumb has room and the whole row is
// grabbable. Vertical swaps the axis; the `data-orientation` selector outranks the plain utility.
const controlSizeStyles: Record<Size, string> = {
    sm: "h-4 data-[orientation=vertical]:w-4",
    md: "h-5 data-[orientation=vertical]:w-5",
    lg: "h-6 data-[orientation=vertical]:w-6"
};

const trackSizeStyles: Record<Size, string> = {
    sm: "h-1 data-[orientation=vertical]:w-1",
    md: "h-1.5 data-[orientation=vertical]:w-1.5",
    lg: "h-2 data-[orientation=vertical]:w-2"
};

const thumbSizeStyles: Record<Size, string> = {
    sm: "size-3",
    md: "size-3.5",
    lg: "size-4"
};

type SliderValueType = number | readonly number[];

type BaseSliderRootProps<Value extends SliderValueType> = ComponentProps<
    typeof BaseSlider.Root<Value>
>;
type BaseSliderLabelProps = ComponentProps<typeof BaseSlider.Label>;
type BaseSliderValueProps = ComponentProps<typeof BaseSlider.Value>;
type BaseSliderControlProps = ComponentProps<typeof BaseSlider.Control>;
type BaseSliderTrackProps = ComponentProps<typeof BaseSlider.Track>;
type BaseSliderIndicatorProps = ComponentProps<
    typeof BaseSlider.Indicator
>;
type BaseSliderThumbProps = ComponentProps<typeof BaseSlider.Thumb>;

export interface SliderRootProps<Value extends SliderValueType = SliderValueType>
    extends Omit<BaseSliderRootProps<Value>, "className"> {
    size?: Size;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}

// Written as a plain generic function rather than `forwardRef` so the `value`/`onValueChange` pair
// stays tied together (number vs. number[]); React 19 takes `ref` as an ordinary prop.
function SliderRoot<Value extends SliderValueType = SliderValueType>({
    size = "md",
    className,
    ...props
}: SliderRootProps<Value>) {
    return (
        <SliderSizeContext.Provider value={size}>
            <BaseSlider.Root
                className={cn(
                    "flex w-full flex-col gap-1.5 select-none",
                    "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:items-center",
                    "data-[disabled]:opacity-50",
                    className
                )}
                {...props}
            />
        </SliderSizeContext.Provider>
    );
}
SliderRoot.displayName = "Slider.Root";

export interface SliderLabelProps
    extends Omit<BaseSliderLabelProps, "className"> {
    className?: string;
}

const SliderLabel = forwardRef<HTMLDivElement, SliderLabelProps>(
    ({ className, ...props }, ref) => (
        <BaseSlider.Label
            ref={ref}
            className={cn(
                "block text-xs font-medium text-dark-100 select-none",
                className
            )}
            {...props}
        />
    )
);
SliderLabel.displayName = "Slider.Label";

export interface SliderValueProps
    extends Omit<BaseSliderValueProps, "className"> {
    className?: string;
}

const SliderValue = forwardRef<HTMLOutputElement, SliderValueProps>(
    ({ className, ...props }, ref) => (
        <BaseSlider.Value
            ref={ref}
            className={cn(
                "shrink-0 text-xs font-medium tabular-nums text-dark-200 select-none",
                className
            )}
            {...props}
        />
    )
);
SliderValue.displayName = "Slider.Value";

export interface SliderControlProps
    extends Omit<BaseSliderControlProps, "className"> {
    size?: Size;
    className?: string;
}

const SliderControl = forwardRef<HTMLDivElement, SliderControlProps>(
    ({ size: sizeProp, className, ...props }, ref) => {
        const contextSize = useContext(SliderSizeContext);
        const size = sizeProp ?? contextSize;

        return (
            <BaseSlider.Control
                ref={ref}
                className={cn(
                    "group relative flex w-full cursor-pointer touch-none items-center select-none",
                    "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col data-[orientation=vertical]:justify-center",
                    "data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed",
                    controlSizeStyles[size],
                    className
                )}
                {...props}
            />
        );
    }
);
SliderControl.displayName = "Slider.Control";

export interface SliderTrackProps
    extends Omit<BaseSliderTrackProps, "className"> {
    size?: Size;
    className?: string;
}

const SliderTrack = forwardRef<HTMLDivElement, SliderTrackProps>(
    ({ size: sizeProp, className, ...props }, ref) => {
        const contextSize = useContext(SliderSizeContext);
        const size = sizeProp ?? contextSize;

        return (
            <BaseSlider.Track
                ref={ref}
                className={cn(
                    "relative w-full overflow-hidden rounded-md bg-dark-600",
                    "transition-colors group-hover:bg-dark-500",
                    "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto",
                    trackSizeStyles[size],
                    className
                )}
                {...props}
            />
        );
    }
);
SliderTrack.displayName = "Slider.Track";

export interface SliderIndicatorProps
    extends Omit<BaseSliderIndicatorProps, "className"> {
    className?: string;
}

const SliderIndicator = forwardRef<HTMLDivElement, SliderIndicatorProps>(
    ({ className, ...props }, ref) => (
        <BaseSlider.Indicator
            ref={ref}
            className={cn("rounded-md bg-primary-100", className)}
            {...props}
        />
    )
);
SliderIndicator.displayName = "Slider.Indicator";

export interface SliderThumbProps
    extends Omit<BaseSliderThumbProps, "className"> {
    size?: Size;
    className?: string;
}

const SliderThumb = forwardRef<HTMLDivElement, SliderThumbProps>(
    ({ size: sizeProp, className, ...props }, ref) => {
        const contextSize = useContext(SliderSizeContext);
        const size = sizeProp ?? contextSize;

        return (
            <BaseSlider.Thumb
                ref={ref}
                className={cn(
                    "rounded-sm bg-primary-100 shadow-sm shadow-black/40",
                    "transition-[transform,background-color,box-shadow] duration-150 ease-out",
                    "hover:scale-110 data-[dragging]:scale-110",
                    "data-[disabled]:pointer-events-none data-[disabled]:hover:scale-100",
                    thumbSizeStyles[size],
                    className
                )}
                {...props}
            />
        );
    }
);
SliderThumb.displayName = "Slider.Thumb";

export interface SliderProps<Value extends SliderValueType = SliderValueType>
    extends Omit<SliderRootProps<Value>, "children"> {
    /** Rendered above the control. Pass a translated string — never a locale key. */
    label?: ReactNode;
    /** Shows the current value opposite the label. Range sliders join both values. */
    showValue?: boolean;
    /** Formats each value for display; the default is the root's `format`/`locale` output. */
    formatValue?: (value: number, index: number) => string;
    labelClassName?: string;
    valueClassName?: string;
    controlClassName?: string;
    trackClassName?: string;
    indicatorClassName?: string;
    thumbClassName?: string;
}

/** One thumb per value — an array `value`/`defaultValue` makes it a range slider. */
function useThumbCount(value: unknown, defaultValue: unknown): number {
    const source = value ?? defaultValue;
    return Array.isArray(source) ? Math.max(source.length, 1) : 1;
}

function SliderComponent<Value extends SliderValueType = SliderValueType>({
    label,
    showValue = false,
    formatValue,
    size = "md",
    labelClassName,
    valueClassName,
    controlClassName,
    trackClassName,
    indicatorClassName,
    thumbClassName,
    ...props
}: SliderProps<Value>) {
    const thumbs = useThumbCount(props.value, props.defaultValue);

    return (
        <SliderRoot size={size} {...props}>
            {(label != null || showValue) && (
                <div className="flex items-center justify-between gap-2">
                    {label != null ? (
                        <SliderLabel className={labelClassName}>
                            {label}
                        </SliderLabel>
                    ) : (
                        <span />
                    )}
                    {showValue && (
                        <SliderValue className={valueClassName}>
                            {formatValue
                                ? (_, values) =>
                                      values.map(formatValue).join(" – ")
                                : undefined}
                        </SliderValue>
                    )}
                </div>
            )}

            <SliderControl className={controlClassName}>
                <SliderTrack className={trackClassName}>
                    <SliderIndicator className={indicatorClassName} />
                </SliderTrack>
                {Array.from({ length: thumbs }, (_, index) => (
                    <SliderThumb
                        key={index}
                        index={index}
                        className={thumbClassName}
                    />
                ))}
            </SliderControl>
        </SliderRoot>
    );
}
SliderComponent.displayName = "Slider";

export const Slider = Object.assign(SliderComponent, {
    Root: SliderRoot,
    Label: SliderLabel,
    Value: SliderValue,
    Control: SliderControl,
    Track: SliderTrack,
    Indicator: SliderIndicator,
    Thumb: SliderThumb
});
