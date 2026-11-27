import { backend } from "@/lib/backend";
import type { GitBranch, GitChanges, GitFileState, GitRepo } from "@/proto";

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

const FAKE_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import { start } from "./start";
-const port = 3000;
+const port = Number(process.env.PORT ?? 3000);
+const host = "localhost";
 
-start(port);
+start(port, host);
 export {};
diff --git a/notes/todo.md b/notes/todo.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/notes/todo.md
@@ -0,0 +1,3 @@
+# Todo
+
+- Ship the changes tab
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-soon
`;

async function fakeChange(change: () => void): Promise<void> {
    change();
}

export const gitApi = {
    /** The uncommitted changes as a patch; null outside a checkout. */
    changes: (cwd: string) =>
        backend<GitChanges | null>("git_changes", { cwd }, () => ({ root: cwd, patch: FAKE_PATCH, skipped: 0 })),
    /** Each uncommitted file at or under `cwd`, by its path from it; null outside a checkout. */
    status: (cwd: string) =>
        backend<Record<string, GitFileState> | null>("git_status", { cwd }, () => ({
            "src/App.tsx": "modified",
            "src/features/composer/Composer.tsx": "untracked",
            "package.json": "conflict"
        })),
    /** The committed text of `path` (from `cwd`), `\n`-separated; null when it has none. */
    headText: (cwd: string, path: string) =>
        backend<string | null>("git_head_text", { cwd, path }, () => `// ${path}\n`),
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
