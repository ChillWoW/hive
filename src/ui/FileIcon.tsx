import { cn } from "@/lib/cn";
import { fileIconUrl, type FileIconOptions } from "@/lib/fileIcons";

type FileIconProps = FileIconOptions & {
    /** A file or folder name, or a path ending in one. */
    name: string;
    className?: string;
};

/**
 * The material-icon-theme icon for a file or folder, as VS Code would show it.
 * Decorative: whatever it sits beside is expected to say the name.
 */
export function FileIcon({ name, folder, open, className }: FileIconProps) {
    return (
        <img
            src={fileIconUrl(name, { folder, open })}
            alt=""
            aria-hidden="true"
            draggable={false}
            className={cn("size-4 shrink-0 select-none", className)}
        />
    );
}
