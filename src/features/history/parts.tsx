import { useState } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { GitHistoryRef } from "@/proto";
import { Tooltip } from "@/ui";
import { describeRef, REF_KIND } from "./display";

/** The pieces the history and commit tabs share: pictures, ref badges, hashes. */

/** The author's GitHub picture, else their initial. */
export function AuthorAvatar({
    name,
    url,
    className
}: {
    name: string;
    url: string | undefined;
    className?: string;
}) {
    const [failed, setFailed] = useState(false);
    const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
    return (
        <span
            className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full",
                "bg-hover text-[10px] font-medium text-muted ring-1 ring-border",
                className
            )}
        >
            {url && !failed ? (
                <img
                    src={url}
                    alt=""
                    className="size-full object-cover"
                    draggable={false}
                    onError={() => setFailed(true)}
                />
            ) : (
                initial
            )}
        </span>
    );
}

/** A branch, remote branch or tag. `current`: the checked-out branch, drawn solid. */
export function RefBadge({ gitRef, current, className }: { gitRef: GitHistoryRef; current?: boolean; className?: string }) {
    const { className: kind, Icon } = REF_KIND[gitRef.kind];
    return (
        <Tooltip disableHoverablePopup>
            <Tooltip.Trigger
                delay={400}
                render={
                    <span
                        className={cn(
                            "inline-flex h-[18px] min-w-0 max-w-28 shrink items-center gap-1 rounded px-1.5 text-[11px] leading-none",
                            current ? "bg-info text-bg" : kind,
                            className
                        )}
                    >
                        <Icon className="size-2.5 shrink-0" weight={current ? "bold" : "regular"} />
                        <span className="min-w-0 truncate">{gitRef.label}</span>
                    </span>
                }
            />
            <Tooltip.Content side="bottom">
                {describeRef(gitRef)}
                {current && " · checked out"}
            </Tooltip.Content>
        </Tooltip>
    );
}

/** A short hash that copies the full one. */
export function HashButton({ sha, className }: { sha: string; className?: string }) {
    const [copied, copy] = useCopy(1200);
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label="Copy the full hash"
                        onClick={(event) => {
                            event.stopPropagation();
                            copy(sha);
                        }}
                        className={cn(
                            "inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[11px] outline-none",
                            "bg-raised text-muted transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover",
                            copied && "text-success hover:text-success",
                            className
                        )}
                    >
                        {copied && <CheckIcon className="size-3" weight="bold" />}
                        {sha.slice(0, 7)}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{copied ? "Copied" : "Copy the full hash"}</Tooltip.Content>
        </Tooltip>
    );
}
