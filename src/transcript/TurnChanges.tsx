import { useContext, useMemo, useState } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { LineCounts } from "@/diff/DiffFiles";
import { parsePatch, totals } from "@/diff/patch";
import { RevertTurnDialog, type RevertRequest } from "@/diff/RevertTurnDialog";
import { useDiffPrefs, useTurnSummary } from "@/diff/store";
import { openDiffTab } from "@/rightbar";
import { Tooltip } from "@/ui";
import { ChatCwd } from "./context";

/**
 * Under the latest reply: what the turn changed in the checkout ("3 files
 * +12 −4", opening the diff tab on Latest turn) and Undo, which puts every
 * file back as the turn found it. Nothing while it changed nothing.
 */
export function TurnChanges({ chatId, messageId }: { chatId: string; messageId: string }) {
    const cwd = useContext(ChatCwd);
    const diff = useTurnSummary(chatId, messageId)?.diff;
    const files = useMemo(() => (diff ? parsePatch(diff.patch) : []), [diff]);
    const [revert, setRevert] = useState<RevertRequest | null>(null);
    if (!cwd || files.length === 0) {
        return <RevertTurnDialog request={revert} onClose={() => setRevert(null)} />;
    }
    const sum = totals(files);

    return (
        <>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <button
                            type="button"
                            onClick={() => {
                                useDiffPrefs.getState().setScope("turn");
                                openDiffTab();
                            }}
                            className="inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-dark-250 transition-colors hover:bg-dark-700 hover:text-dark-50"
                        >
                            {sum.files === 1 ? "1 file" : `${sum.files} files`}
                            <LineCounts additions={sum.additions} deletions={sum.deletions} />
                        </button>
                    }
                />
                <Tooltip.Content side="bottom">Show this turn's changes</Tooltip.Content>
            </Tooltip>
            {!diff?.truncated && (
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <button
                                type="button"
                                aria-label="Undo this turn's changes"
                                onClick={() => setRevert({ chatId, cwd, files, whole: true })}
                                className="inline-flex size-6 items-center justify-center rounded-sm text-dark-250 transition-colors hover:bg-dark-700 hover:text-dark-50"
                            >
                                <ArrowCounterClockwiseIcon className="size-3.5" />
                            </button>
                        }
                    />
                    <Tooltip.Content side="bottom">Undo this turn's changes</Tooltip.Content>
                </Tooltip>
            )}
            <RevertTurnDialog request={revert} onClose={() => setRevert(null)} />
        </>
    );
}
