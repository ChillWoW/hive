import { BookOpenIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import { FileIcon, Tooltip } from "@/ui";
import type { Tag } from "./tags";

const chipClassName =
    "mx-px inline-flex h-5 max-w-64 translate-y-[-1px] items-center gap-1 rounded-md bg-hover pr-1.5 pl-1 align-middle text-xs leading-none text-text select-none";

/**
 * A tag as drawn in the composer and in a sent prompt alike: a file or
 * folder by its icon and name, a skill, a command. Plain markup only (the
 * composer renders it to a string for its widgets); `TagChip` adds the
 * tooltip.
 */
export function TagFace({ tag }: { tag: Tag }) {
    switch (tag.kind) {
        case "file": {
            const folder = tag.path.endsWith("/");
            const name = baseName(tag.path);
            return (
                <span className={chipClassName}>
                    <FileIcon name={name} folder={folder} className="size-3.5" />
                    <span className="truncate">{name}</span>
                </span>
            );
        }
        case "skill":
            return (
                <span className={chipClassName}>
                    <BookOpenIcon className="size-3.5 shrink-0 text-info" weight="fill" />
                    <span className="truncate">{tag.name}</span>
                </span>
            );
        case "command":
            return (
                <span className={cn(chipClassName, "gap-0 pl-1.5")}>
                    <span className="text-muted">/</span>
                    <span className="truncate">{tag.name}</span>
                </span>
            );
    }
}

/** `TagFace` with the path a file tag stands for in a tooltip. */
export function TagChip({ tag }: { tag: Tag }) {
    if (tag.kind !== "file") return <TagFace tag={tag} />;
    return (
        <Tooltip>
            <Tooltip.Trigger render={<span />}>
                <TagFace tag={tag} />
            </Tooltip.Trigger>
            <Tooltip.Content side="top" className="max-w-80 break-all">
                {tag.path.replace(/\/$/, "")}
            </Tooltip.Content>
        </Tooltip>
    );
}
