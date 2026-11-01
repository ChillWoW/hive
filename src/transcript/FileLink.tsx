import type { ReactNode } from "react";
import { baseName } from "@/lib/paths";
import { openFileTab } from "@/rightbar";
import { FileIcon, Tooltip } from "@/ui";
import type { FileTarget } from "./filePaths";
import { LINK_CLASS, LINK_ICON_CLASS } from "./WebLink";

const lineSuffix = (target: FileTarget) =>
    target.at ? `:${target.at.line}${target.at.column ? `:${target.at.column}` : ""}` : "";

/** The whole path a tooltip shows: absolute, `\`s under a Windows drive. */
function fullPath(target: FileTarget) {
    const sep = /^[a-z]:/i.test(target.cwd) && target.cwd.includes("\\") ? "\\" : "/";
    const base = target.cwd.replace(/[\\/]+$/, "");
    const path = sep === "\\" ? target.path.replace(/\//g, "\\") : target.path;
    return `${base}${sep}${path}${lineSuffix(target)}`;
}

/**
 * A file an agent named, inline in its text: the file's icon and its name
 * (or the link's own label), the whole path in a tooltip; a click opens it in
 * Hive's editor, at the line when one was given.
 */
export function FileLink({ target, children }: { target: FileTarget; children?: ReactNode }) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        onClick={() => openFileTab(target.cwd, target.path, target.at)}
                        className={LINK_CLASS}
                    >
                        <FileIcon name={target.path} className={LINK_ICON_CLASS} />
                        {children ?? `${baseName(target.path)}${lineSuffix(target)}`}
                    </button>
                }
            />
            <Tooltip.Content side="top">{fullPath(target)}</Tooltip.Content>
        </Tooltip>
    );
}
