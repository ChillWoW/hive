import { FileIcon, Tooltip } from "@/ui";

/**
 * An `@` mention in a sent prompt, drawn as the file or folder it names: its
 * icon and name, the whole path in the tooltip.
 */
export function FileTag({ path }: { path: string }) {
    const folder = path.endsWith("/");
    const trimmed = folder ? path.slice(0, -1) : path;
    const name = trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;

    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <span className="mx-px inline-flex h-5 max-w-64 translate-y-[-1px] items-center gap-1 rounded-md bg-dark-600 pr-1.5 pl-1 align-middle text-xs leading-none text-dark-50">
                        <FileIcon name={name} folder={folder} className="size-3.5" />
                        <span className="truncate">{name}</span>
                    </span>
                }
            />
            <Tooltip.Content side="top">{trimmed}</Tooltip.Content>
        </Tooltip>
    );
}
