import { forwardRef } from "react";
import type { ComponentProps, FC } from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import {
    CaretDownIcon,
    CaretUpDownIcon,
    CaretUpIcon,
    CheckIcon
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { usePortalContainer } from "./PortalContainer";

type Size = "sm" | "md" | "lg";

const triggerSizeStyles: Record<Size, string> = {
    sm: "h-6 gap-1 px-2 text-xs",
    md: "h-8 gap-2 px-2.5 text-sm",
    lg: "h-10 gap-2.5 px-3 text-sm"
};

type BaseSelectLabelProps = ComponentProps<typeof BaseSelect.Label>;
type BaseSelectTriggerProps = ComponentProps<typeof BaseSelect.Trigger>;
type BaseSelectValueProps = ComponentProps<typeof BaseSelect.Value>;
type BaseSelectIconProps = ComponentProps<typeof BaseSelect.Icon>;
type BaseSelectBackdropProps = ComponentProps<typeof BaseSelect.Backdrop>;
type BaseSelectPortalProps = ComponentProps<typeof BaseSelect.Portal>;
type BaseSelectPositionerProps = ComponentProps<
    typeof BaseSelect.Positioner
>;
type BaseSelectPopupProps = ComponentProps<typeof BaseSelect.Popup>;
type BaseSelectListProps = ComponentProps<typeof BaseSelect.List>;
type BaseSelectArrowProps = ComponentProps<typeof BaseSelect.Arrow>;
type BaseSelectItemProps = ComponentProps<typeof BaseSelect.Item>;
type BaseSelectItemTextProps = ComponentProps<typeof BaseSelect.ItemText>;
type BaseSelectItemIndicatorProps = ComponentProps<
    typeof BaseSelect.ItemIndicator
>;
type BaseSelectGroupProps = ComponentProps<typeof BaseSelect.Group>;
type BaseSelectGroupLabelProps = ComponentProps<
    typeof BaseSelect.GroupLabel
>;
type BaseSelectScrollUpArrowProps = ComponentProps<
    typeof BaseSelect.ScrollUpArrow
>;
type BaseSelectScrollDownArrowProps = ComponentProps<
    typeof BaseSelect.ScrollDownArrow
>;
type BaseSelectSeparatorProps = ComponentProps<
    typeof BaseSelect.Separator
>;

const triggerBaseClassName = cn(
    "inline-flex w-full select-none items-center justify-between rounded-sm",
    "bg-dark-700 text-dark-50 border border-dark-500",
    "transition-[background-color,border-color,color]",
    "hover:border-dark-400",
    "data-[popup-open]:border-dark-400 data-[focused]:border-dark-400",
    "data-[invalid]:border-danger",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

// `pointer-events-auto`: this portals into the shell's overlay layer, which is
// click-through so the window stays draggable behind a modal. Anything mounted
// there has to opt back in or it renders and ignores the mouse.
const popupBaseClassName = cn(
    "pointer-events-auto min-w-[var(--anchor-width)] max-h-[var(--available-height)] overflow-y-auto outline-none",
    "bg-dark-850 text-dark-50 border border-dark-600",
    "rounded-sm shadow-lg shadow-black/40",
    "p-1",
    "[transform-origin:var(--transform-origin)]",
    "transition-[opacity,transform,scale] duration-150 ease-out",
    "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
    "data-[ending-style]:opacity-0 data-[ending-style]:scale-95"
);

const itemBaseClassName = cn(
    "relative flex w-full cursor-pointer select-none items-center gap-2",
    "rounded-xs py-1.5 pr-7 pl-2.5 text-xs text-dark-50 outline-none",
    "transition-colors",
    "data-[highlighted]:bg-dark-700",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

const indicatorWrapperClassName = cn(
    "absolute right-1.5 inline-flex size-4 shrink-0 items-center justify-center text-dark-50",
    "transition-opacity",
    "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
);

const scrollArrowClassName = cn(
    "sticky z-10 flex h-6 cursor-default items-center justify-center",
    "bg-dark-850 text-dark-200",
    "transition-opacity",
    "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
);

const SelectRoot = BaseSelect.Root;
(SelectRoot as { displayName?: string }).displayName = "Select";

export interface SelectLabelProps
    extends Omit<BaseSelectLabelProps, "className"> {
    className?: string;
}

const SelectLabel = forwardRef<HTMLDivElement, SelectLabelProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.Label
            ref={ref}
            className={cn(
                "mb-1.5 block text-xs font-medium text-dark-100",
                className
            )}
            {...props}
        />
    )
);
SelectLabel.displayName = "Select.Label";

export interface SelectTriggerProps
    extends Omit<BaseSelectTriggerProps, "className"> {
    size?: Size;
    invalid?: boolean;
    className?: string;
}

const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
    ({ size = "md", invalid, className, ...props }, ref) => (
        <BaseSelect.Trigger
            ref={ref}
            data-invalid={invalid || undefined}
            className={cn(
                triggerBaseClassName,
                triggerSizeStyles[size],
                className
            )}
            {...props}
        />
    )
);
SelectTrigger.displayName = "Select.Trigger";

export interface SelectValueProps
    extends Omit<BaseSelectValueProps, "className"> {
    className?: string;
}

const SelectValue = forwardRef<HTMLSpanElement, SelectValueProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.Value
            ref={ref}
            className={cn(
                "min-w-0 flex-1 truncate text-left",
                "data-[placeholder]:text-dark-200",
                className
            )}
            {...props}
        />
    )
);
SelectValue.displayName = "Select.Value";

export interface SelectIconProps
    extends Omit<BaseSelectIconProps, "className"> {
    className?: string;
}

const SelectIcon = forwardRef<HTMLSpanElement, SelectIconProps>(
    ({ className, children, ...props }, ref) => (
        <BaseSelect.Icon
            ref={ref}
            className={cn(
                "ml-1 inline-flex shrink-0 items-center justify-center text-dark-200",
                className
            )}
            {...props}
        >
            {children ?? <CaretUpDownIcon className="size-3.5" weight="bold" />}
        </BaseSelect.Icon>
    )
);
SelectIcon.displayName = "Select.Icon";

export interface SelectBackdropProps
    extends Omit<BaseSelectBackdropProps, "className"> {
    className?: string;
}

const SelectBackdrop = forwardRef<HTMLDivElement, SelectBackdropProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.Backdrop
            ref={ref}
            className={cn(
                "pointer-events-auto fixed inset-0 z-40",
                "transition-opacity duration-150 ease-out",
                "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
                className
            )}
            {...props}
        />
    )
);
SelectBackdrop.displayName = "Select.Backdrop";

export interface SelectPortalProps extends BaseSelectPortalProps {}

/** Into the shell's overlay layer by default, like every other popup. */
const SelectPortal: FC<SelectPortalProps> = ({ container, ...props }) => {
    const portalContainer = usePortalContainer();
    return (
        <BaseSelect.Portal
            container={container ?? portalContainer ?? undefined}
            {...props}
        />
    );
};
(SelectPortal as { displayName?: string }).displayName = "Select.Portal";

export interface SelectPositionerProps
    extends Omit<BaseSelectPositionerProps, "className"> {
    className?: string;
}

const SelectPositioner = forwardRef<
    HTMLDivElement,
    SelectPositionerProps
>(
    (
        { className, sideOffset = 6, alignItemWithTrigger = false, ...props },
        ref
    ) => (
        <BaseSelect.Positioner
            ref={ref}
            sideOffset={sideOffset}
            alignItemWithTrigger={alignItemWithTrigger}
            className={cn("z-50 outline-none", className)}
            {...props}
        />
    )
);
SelectPositioner.displayName = "Select.Positioner";

export interface SelectPopupProps
    extends Omit<BaseSelectPopupProps, "className"> {
    className?: string;
}

const SelectPopup = forwardRef<HTMLDivElement, SelectPopupProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.Popup
            ref={ref}
            className={cn(popupBaseClassName, className)}
            {...props}
        />
    )
);
SelectPopup.displayName = "Select.Popup";

export interface SelectListProps
    extends Omit<BaseSelectListProps, "className"> {
    className?: string;
}

const SelectList = forwardRef<HTMLDivElement, SelectListProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.List
            ref={ref}
            className={cn("outline-none", className)}
            {...props}
        />
    )
);
SelectList.displayName = "Select.List";

export interface SelectArrowProps
    extends Omit<BaseSelectArrowProps, "className"> {
    className?: string;
}

const SelectArrow = forwardRef<HTMLDivElement, SelectArrowProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.Arrow
            ref={ref}
            className={cn(
                "size-2 rotate-45 bg-dark-850 border border-dark-600",
                className
            )}
            {...props}
        />
    )
);
SelectArrow.displayName = "Select.Arrow";

export interface SelectItemProps
    extends Omit<BaseSelectItemProps, "className"> {
    className?: string;
}

const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.Item
            ref={ref}
            className={cn(itemBaseClassName, className)}
            {...props}
        />
    )
);
SelectItem.displayName = "Select.Item";

export interface SelectItemTextProps
    extends Omit<BaseSelectItemTextProps, "className"> {
    className?: string;
}

const SelectItemText = forwardRef<HTMLDivElement, SelectItemTextProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.ItemText
            ref={ref}
            className={cn("min-w-0 flex-1 truncate", className)}
            {...props}
        />
    )
);
SelectItemText.displayName = "Select.ItemText";

export interface SelectItemIndicatorProps
    extends Omit<BaseSelectItemIndicatorProps, "className"> {
    className?: string;
}

const SelectItemIndicator = forwardRef<
    HTMLSpanElement,
    SelectItemIndicatorProps
>(({ className, children, ...props }, ref) => (
    <BaseSelect.ItemIndicator
        ref={ref}
        className={cn(indicatorWrapperClassName, className)}
        {...props}
    >
        {children ?? <CheckIcon className="size-3.5" weight="bold" />}
    </BaseSelect.ItemIndicator>
));
SelectItemIndicator.displayName = "Select.ItemIndicator";

export interface SelectGroupProps extends BaseSelectGroupProps {}

const SelectGroup = BaseSelect.Group as FC<SelectGroupProps>;
(SelectGroup as { displayName?: string }).displayName = "Select.Group";

export interface SelectGroupLabelProps
    extends Omit<BaseSelectGroupLabelProps, "className"> {
    className?: string;
}

const SelectGroupLabel = forwardRef<
    HTMLDivElement,
    SelectGroupLabelProps
>(({ className, ...props }, ref) => (
    <BaseSelect.GroupLabel
        ref={ref}
        className={cn(
            "px-2.5 py-1 text-[11px] font-medium text-dark-200",
            className
        )}
        {...props}
    />
));
SelectGroupLabel.displayName = "Select.GroupLabel";

export interface SelectScrollUpArrowProps
    extends Omit<BaseSelectScrollUpArrowProps, "className"> {
    className?: string;
}

const SelectScrollUpArrow = forwardRef<
    HTMLDivElement,
    SelectScrollUpArrowProps
>(({ className, children, ...props }, ref) => (
    <BaseSelect.ScrollUpArrow
        ref={ref}
        className={cn(scrollArrowClassName, "top-0 -mx-1 -mt-1", className)}
        {...props}
    >
        {children ?? <CaretUpIcon className="size-3.5" weight="bold" />}
    </BaseSelect.ScrollUpArrow>
));
SelectScrollUpArrow.displayName = "Select.ScrollUpArrow";

export interface SelectScrollDownArrowProps
    extends Omit<BaseSelectScrollDownArrowProps, "className"> {
    className?: string;
}

const SelectScrollDownArrow = forwardRef<
    HTMLDivElement,
    SelectScrollDownArrowProps
>(({ className, children, ...props }, ref) => (
    <BaseSelect.ScrollDownArrow
        ref={ref}
        className={cn(scrollArrowClassName, "bottom-0 -mx-1 -mb-1", className)}
        {...props}
    >
        {children ?? <CaretDownIcon className="size-3.5" weight="bold" />}
    </BaseSelect.ScrollDownArrow>
));
SelectScrollDownArrow.displayName = "Select.ScrollDownArrow";

export interface SelectSeparatorProps
    extends Omit<BaseSelectSeparatorProps, "className"> {
    className?: string;
}

const SelectSeparator = forwardRef<HTMLDivElement, SelectSeparatorProps>(
    ({ className, ...props }, ref) => (
        <BaseSelect.Separator
            ref={ref}
            className={cn("-mx-1 my-1 h-px bg-dark-600", className)}
            {...props}
        />
    )
);
SelectSeparator.displayName = "Select.Separator";

export const Select = Object.assign(SelectRoot, {
    Label: SelectLabel,
    Trigger: SelectTrigger,
    Value: SelectValue,
    Icon: SelectIcon,
    Backdrop: SelectBackdrop,
    Portal: SelectPortal,
    Positioner: SelectPositioner,
    Popup: SelectPopup,
    List: SelectList,
    Arrow: SelectArrow,
    Item: SelectItem,
    ItemText: SelectItemText,
    ItemIndicator: SelectItemIndicator,
    Group: SelectGroup,
    GroupLabel: SelectGroupLabel,
    ScrollUpArrow: SelectScrollUpArrow,
    ScrollDownArrow: SelectScrollDownArrow,
    Separator: SelectSeparator
});
