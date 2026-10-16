import { createContext, forwardRef, useContext } from "react";
import type { ComponentProps } from "react";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";

const sizeStyles: Record<Size, { root: string; text: string }> = {
    sm: { root: "size-6", text: "text-[10px]" },
    md: { root: "size-8", text: "text-xs" },
    lg: { root: "size-10", text: "text-sm" }
};

type AvatarFieldContextValue = {
    size: Size;
};

const AvatarFieldContext = createContext<AvatarFieldContextValue>({
    size: "md"
});

type BaseAvatarRootProps = ComponentProps<typeof BaseAvatar.Root>;
type BaseAvatarImageProps = ComponentProps<typeof BaseAvatar.Image>;
type BaseAvatarFallbackProps = ComponentProps<typeof BaseAvatar.Fallback>;

export interface AvatarRootProps
    extends Omit<BaseAvatarRootProps, "className"> {
    size?: Size;
    className?: string;
}

const AvatarRoot = forwardRef<HTMLSpanElement, AvatarRootProps>(
    ({ size = "md", className, children, ...props }, ref) => (
        <AvatarFieldContext.Provider value={{ size }}>
            <BaseAvatar.Root
                ref={ref}
                className={cn(
                    "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
                    "border border-dark-500 bg-dark-700",
                    sizeStyles[size].root,
                    className
                )}
                {...props}
            >
                {children}
            </BaseAvatar.Root>
        </AvatarFieldContext.Provider>
    )
);
AvatarRoot.displayName = "Avatar.Root";

export interface AvatarImageProps
    extends Omit<BaseAvatarImageProps, "className"> {
    className?: string;
}

const AvatarImage = forwardRef<HTMLImageElement, AvatarImageProps>(
    ({ className, ...props }, ref) => (
        <BaseAvatar.Image
            ref={ref}
            className={cn("size-full object-cover", className)}
            {...props}
        />
    )
);
AvatarImage.displayName = "Avatar.Image";

export interface AvatarFallbackProps
    extends Omit<BaseAvatarFallbackProps, "className"> {
    className?: string;
}

const AvatarFallback = forwardRef<HTMLSpanElement, AvatarFallbackProps>(
    ({ className, ...props }, ref) => {
        const { size } = useContext(AvatarFieldContext);

        return (
            <BaseAvatar.Fallback
                ref={ref}
                className={cn(
                    "flex size-full items-center justify-center font-medium uppercase text-dark-50 select-none",
                    sizeStyles[size].text,
                    className
                )}
                {...props}
            />
        );
    }
);
AvatarFallback.displayName = "Avatar.Fallback";

export const Avatar = Object.assign(AvatarRoot, {
    Image: AvatarImage,
    Fallback: AvatarFallback
});
