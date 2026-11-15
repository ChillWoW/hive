import type { ReactNode } from "react";
import { openFile } from "@/lib/files";
import { baseName } from "@/lib/paths";
import { FileIcon, toast, Tooltip } from "@/ui";
import { fullPath, type FileTarget } from "./filePaths";
import { LINK_CLASS, LINK_ICON_CLASS } from "./WebLink";

const lineSuffix = (target: FileTarget) =>
    target.at ? `:${target.at.line}${target.at.column ? `:${target.at.column}` : ""}` : "";

/**
 * A file an agent named, inline in its text: the file's icon and its name
 * (or the link's own label), the whole path in a tooltip; a click opens it
 * in the system's default app.
 */
export function FileLink({ target, children }: { target: FileTarget; children?: ReactNode }) {
    const path = fullPath(target);
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        onClick={() =>
                            void openFile(path).catch((error: unknown) =>
                                toast.error({ title: `Couldn't open ${baseName(path)}`, description: String(error) })
                            )
                        }
                        className={LINK_CLASS}
                    >
                        <FileIcon name={target.path} className={LINK_ICON_CLASS} />
                        {children ?? `${baseName(target.path)}${lineSuffix(target)}`}
                    </button>
                }
            />
            <Tooltip.Content side="top">{`${path}${lineSuffix(target)}`}</Tooltip.Content>
        </Tooltip>
    );
}
