import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { FileIcon } from "@/ui";

/** A file that isn't drawn as an image: a slim pill of its icon and name. */
export function FileChip({
    name,
    className,
    children
}: {
    name: string;
    className?: string;
    /** Drawn over the chip, like the composer's remove button. */
    children?: ReactNode;
}) {
    return (
        <div
            className={cn(
                "relative flex h-8 max-w-52 min-w-0 items-center gap-1.5 rounded-xl border border-dark-600 bg-dark-800 pr-2.5 pl-2",
                className
            )}
        >
            <FileIcon name={name} className="size-4" />
            <span className="truncate text-[13px] text-dark-100">{name}</span>
            {children}
        </div>
    );
}
