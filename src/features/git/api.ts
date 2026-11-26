import { backend } from "@/lib/backend";
import type { GitBranch, GitRepo } from "@/proto";

/**
 * Transport for a folder's branches (`src-tauri/src/git.rs`). Under a plain
 * `bun run dev` there's no backend: every folder is the same made-up
 * repository, kept in memory so the picker can be tried out.
 */

const HOUR = 60 * 60 * 1000;
const fake = {
    current: "main",
    branches: [
        { name: "main", age: 2 },
        { name: "feat/branch-picker", age: 0.2 },
        { name: "fix/sidebar-scroll", age: 30 },
        { name: "outcode/dark-mode", age: 5 }
    ]
};

function fakeRepo(cwd: string): GitRepo {
    const now = Date.now();
    const branches: GitBranch[] = fake.branches
        .map((b) => ({
            name: b.name,
            current: b.name === fake.current,
            merged: b.name === fake.current || b.name === "main",
            committedAt: now - b.age * HOUR,
            worktree: b.name.startsWith("outcode/") ? "~/.outcode/worktrees/x" : undefined
        }))
        .sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));
    return { root: cwd, branch: fake.current, commit: "5c93f90", changes: 0, branches };
}

async function fakeChange(change: () => void): Promise<void> {
    change();
}

export const gitApi = {
    /** Null outside a checkout. */
    repo: (cwd: string) => backend<GitRepo | null>("git_repo", { cwd }, () => fakeRepo(cwd)),
    switchBranch: (cwd: string, name: string) =>
        backend<void>("git_switch_branch", { cwd, name }, () =>
            fakeChange(() => {
                fake.current = name;
            })
        ),
    /** Branches off `from` and switches to the new branch. */
    createBranch: (cwd: string, name: string, from: string) =>
        backend<void>("git_create_branch", { cwd, name, from }, () =>
            fakeChange(() => {
                if (fake.branches.some((b) => b.name === name)) {
                    throw new Error(`a branch named '${name}' already exists`);
                }
                fake.branches.push({ name, age: 0 });
                fake.current = name;
            })
        ),
    deleteBranch: (cwd: string, name: string) =>
        backend<void>("git_delete_branch", { cwd, name }, () =>
            fakeChange(() => {
                fake.branches = fake.branches.filter((b) => b.name !== name);
            })
        )
};
