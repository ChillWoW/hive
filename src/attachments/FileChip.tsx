import type { ReactNode } from "react";
import {
    FileCodeIcon,
    FileCsvIcon,
    FileIcon,
    FileImageIcon,
    FileMdIcon,
    FilePdfIcon,
    FileTextIcon,
    FileZipIcon
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

const CODE = /\.(rs|ts|tsx|js|jsx|py|go|java|c|h|cpp|hpp|cs|rb|php|sh|ps1|swift|kt|lua|json|toml|ya?ml|xml|html?|css|sql)$/i;

function iconFor(name: string, mimeType: string) {
    if (mimeType === "application/pdf") return FilePdfIcon;
    if (mimeType.startsWith("image/")) return FileImageIcon;
    if (mimeType === "application/zip" || /\.(zip|tar|gz|7z|rar)$/i.test(name)) return FileZipIcon;
    if (/\.csv$/i.test(name)) return FileCsvIcon;
    if (/\.(md|markdown)$/i.test(name)) return FileMdIcon;
    if (CODE.test(name)) return FileCodeIcon;
    if (mimeType.startsWith("text/")) return FileTextIcon;
    return FileIcon;
}

/** A file that isn't drawn as an image: a slim pill of its icon and name. */
export function FileChip({
    name,
    mimeType,
    className,
    children
}: {
    name: string;
    mimeType: string;
    className?: string;
    /** Drawn over the chip, like the composer's remove button. */
    children?: ReactNode;
}) {
    const Icon = iconFor(name, mimeType);
    return (
        <div
            className={cn(
                "relative flex h-8 max-w-52 min-w-0 items-center gap-1.5 rounded-xl border border-dark-600 bg-dark-800 pr-2.5 pl-2",
                className
            )}
        >
            <Icon className="size-4 shrink-0 text-dark-200" />
            <span className="truncate text-[13px] text-dark-100">{name}</span>
            {children}
        </div>
    );
}
