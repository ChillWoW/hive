import { use, useMemo, useState } from "react";
import { ArrowUUpLeftIcon, GitDiffIcon } from "@phosphor-icons/react";
import {
    LineCounts,
    openTurnChangesTab,
    parsePatch,
    RevertTurnDialog,
    useTurnChanges,
    type RevertRequest
} from "@/features/changes";
import { Tooltip } from "@/ui";
import { ChatCwd } from "./context";

const buttonClassName =
    "inline-flex h-6 items-center justify-center rounded-sm text-muted/85 transition-colors hover:bg-hover hover:text-text";

/**
 * In the latest reply's footer: what the turn changed in the checkout
 * ("3 files +12 −4", opening those changes in a diff tab) and an undo that
 * puts every file back as the turn found it, set off from what's before
 * them in the footer by a hairline. Nothing while it changed
 * nothing, or no turn is recorded (none since launch, or outside a checkout).
 */
export function TurnChanges({ chatId }: { chatId: string }) {
    const cwd = use(ChatCwd);
    const { changes } = useTurnChanges(chatId);
    const patch = changes?.patch ?? "";
    const files = useMemo(() => parsePatch(patch), [patch]);
    const [revert, setRevert] = useState<RevertRequest | null>(null);
    const dialog = <RevertTurnDialog request={revert} onClose={() => setRevert(null)} />;
    if (!cwd || files.length === 0) return dialog;
    const additions = files.reduce((sum, f) => sum + f.additions, 0);
    const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return (
        <>
            {/* Count and undo are one group, apart from the reply's own buttons. */}
            <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border first:hidden" />
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <button
                            type="button"
                            onClick={() => openTurnChangesTab(chatId, cwd)}
                            className={`${buttonClassName} gap-1.5 px-1.5 text-xs tabular-nums`}
                        >
                            <GitDiffIcon className="size-3.5 shrink-0" />
                            {files.length === 1 ? "1 file" : `${files.length} files`}
                            <LineCounts additions={additions} deletions={deletions} />
                        </button>
                    }
                />
                <Tooltip.Content side="bottom">Show this turn's changes</Tooltip.Content>
            </Tooltip>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <button
                            type="button"
                            aria-label="Undo this turn's changes"
                            onClick={() => setRevert({ chatId, cwd, files, whole: true })}
                            className={`${buttonClassName} size-6`}
                        >
                            <ArrowUUpLeftIcon className="size-3.5" />
                        </button>
                    }
                />
                <Tooltip.Content side="bottom">Undo this turn's changes</Tooltip.Content>
            </Tooltip>
            {dialog}
        </>
    );
}
