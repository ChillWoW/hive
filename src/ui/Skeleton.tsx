import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** A pulsing placeholder block; size and rounding come from `className`. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
    return <div className={cn("block shrink-0 animate-pulse bg-dark-700", className)} {...props} />;
}
