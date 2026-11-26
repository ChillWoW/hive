import { GitForkIcon } from "@phosphor-icons/react";
import type { Worktree } from "@/proto";
import type { WorktreeSetup } from "../setup";
import { Divider } from "./Dividers";

const icon = <GitForkIcon className="size-3.5 shrink-0" />;

/**
 * A chat's worktree, as a line across the transcript under its first
 * prompt (like a compaction): a shimmering "Setting up a worktree" while
 * it's made (its branch once named), then "Worktree ready" and the branch.
 * A failed setup says why. Without `setup` (made before a reload) only the
 * worktree.
 */
export function WorktreeDivider({ setup, worktree }: { setup?: WorktreeSetup | null; worktree?: Worktree }) {
    if (setup?.error && !worktree) {
        return (
            <div className="flex flex-col gap-1">
                <Divider icon={icon} className="text-danger/90">
                    Couldn't set up a worktree
                </Divider>
                <p className="text-center text-xs break-words whitespace-pre-wrap text-danger/80">{setup.error}</p>
            </div>
        );
    }
    if (setup && !setup.endedAt) {
        const branch = setup.stages.findLast((s) => s.branch)?.branch;
        return (
            <Divider icon={icon}>
                <span className="shimmer">Setting up a worktree</span>
                {branch && <span> · {branch}</span>}
            </Divider>
        );
    }
    if (!worktree) return null;
    return (
        <Divider icon={icon}>
            Worktree ready · {worktree.branch}
        </Divider>
    );
}
