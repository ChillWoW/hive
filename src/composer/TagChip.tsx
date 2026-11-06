import { useState } from "react";
import {
    CaretUpIcon,
    ChatTextIcon,
    ClipboardTextIcon,
    PuzzlePieceIcon
} from "@phosphor-icons/react";
import { pasteLines } from "./pastes";
import { cn } from "@/lib/cn";
import { labelTitle } from "@/review/comments";
import { FileIcon, Tooltip } from "@/ui";
import { baseName } from "@/lib/paths";
import type { Tag } from "./tags";

/** What a comment tag shows: the file, its lines (`linesLabel`) and the comment. */
export type TagComment = { path: string; lines: string; body: string };

const chipClassName =
    "mx-px inline-flex h-5 max-w-64 translate-y-[-1px] items-center gap-1 rounded-md bg-dark-600 pr-1.5 pl-1 align-middle text-xs leading-none text-dark-50 select-none";

/**
 * A tag as drawn in the composer and in a sent prompt alike: a file or
 * folder by its icon and name, a skill, a command, a diff comment by its
 * file, lines and text. Plain markup only (the composer renders it to a
 * string for its widgets); `TagChip` adds the tooltip.
 */
export function TagFace({ tag, comment }: { tag: Tag; comment?: TagComment }) {
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
                    <PuzzlePieceIcon className="size-3.5 shrink-0 text-info" weight="fill" />
                    <span className="truncate">{tag.name}</span>
                </span>
            );
        case "command":
            return (
                <span className={cn(chipClassName, "pl-1.5")}>
                    <span className="text-dark-250">/</span>
                    <span className="-ml-0.5 truncate">{tag.name}</span>
                </span>
            );
        case "comment": {
            if (!comment) {
                return (
                    <span className={chipClassName}>
                        <ChatTextIcon className="size-3.5 shrink-0 text-info" />
                        <span className="truncate">comment</span>
                    </span>
                );
            }
            const name = baseName(comment.path);
            return (
                <span className={cn(chipClassName, "max-w-72")}>
                    <ChatTextIcon className="size-3.5 shrink-0 text-info" />
                    <FileIcon name={name} className="size-3.5" />
                    <span className="shrink-0">
                        {name}
                        <span className="text-dark-200">
                            :{labelTitle(comment.lines).replace(/^(old )?L/, "$1")}
                        </span>
                    </span>
                    <span className="min-w-0 truncate text-dark-200">{comment.body}</span>
                </span>
            );
        }
    }
}

/**
 * A big paste folded (`pastes.ts`), in the composer and a sent prompt alike:
 * its size, clickable to unfold. Plain markup, as `TagFace`.
 */
export function PasteFace({ raw, open = false }: { raw: string; open?: boolean }) {
    const lines = pasteLines(raw);
    const size = lines > 1 ? `${lines} lines` : `${raw.length.toLocaleString()} chars`;
    return (
        <span className={cn(chipClassName, "cursor-pointer hover:bg-dark-500")}>
            <ClipboardTextIcon className="size-3.5 shrink-0 text-dark-200" />
            <span className="shrink-0">Pasted text</span>
            <span className="shrink-0 text-dark-200">{size}</span>
            {open && <CaretUpIcon className="size-3 shrink-0 text-dark-200" />}
        </span>
    );
}

/**
 * A sent prompt's paste: folded to its chip, a click shows the text under it
 * (and folds it again).
 */
export function PasteChip({ raw }: { raw: string }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="contents"
            >
                <PasteFace raw={raw} open={open} />
            </button>
            {open && (
                <span className="my-1 block rounded-md bg-dark-850 px-2 py-1 text-[13px] whitespace-pre-wrap">
                    {raw.replace(/\n$/, "")}
                </span>
            )}
        </>
    );
}

/** `TagFace` with what it stands for in a tooltip: a path, a comment in full. */
export function TagChip({ tag, comment }: { tag: Tag; comment?: TagComment }) {
    const tip =
        tag.kind === "file" ? (
            tag.path.replace(/\/$/, "")
        ) : tag.kind === "comment" && comment ? (
            <>
                <div className="font-mono text-[11px] text-dark-200">
                    {comment.path} · {labelTitle(comment.lines)}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap">{comment.body}</div>
            </>
        ) : null;
    if (!tip) return <TagFace tag={tag} comment={comment} />;
    return (
        <Tooltip>
            <Tooltip.Trigger render={<span />}>
                <TagFace tag={tag} comment={comment} />
            </Tooltip.Trigger>
            <Tooltip.Content side="top" className="max-w-80">
                {tip}
            </Tooltip.Content>
        </Tooltip>
    );
}
