import { invoke } from "@tauri-apps/api/core";
import type { GitBranch, GitDiff, GitRepo } from "@/proto";
import { isTauri } from "@/lib/platform";

/**
 * Transport for a folder's branches (`src-tauri/src/git.rs`). Under a plain
 * `bun run dev` there's no backend: every folder is the same made-up
 * repository, kept in memory so the picker can be tried out.
 */

const HOUR = 60 * 60 * 1000;
const fake = {
    current: "main" as string,
    branches: [
        { name: "main", subject: "feat: providers settings page", age: 2 },
        { name: "feat/git-branches", subject: "wip: branch picker", age: 0.2 },
        { name: "fix/sidebar-scroll", subject: "fix: keep the open chat in view", age: 30 },
        { name: "hive/add-dark-mode", subject: "feat: dark mode toggle", age: 5 }
    ]
};

function fakeRepo(cwd: string): GitRepo {
    const now = Date.now();
    const branches: GitBranch[] = fake.branches
        .map((b) => ({
            name: b.name,
            current: b.name === fake.current,
            merged: b.name === fake.current || b.name === "main",
            upstream: b.name === "main" ? "origin/main" : undefined,
            ahead: 0,
            behind: 0,
            committedAt: now - b.age * HOUR,
            subject: b.subject,
            worktree: b.name.startsWith("hive/") ? "~/hive/worktrees/x/repo" : undefined
        }))
        .sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));
    return { root: cwd, branch: fake.current, commit: "5c93f90", changes: 2, branches };
}

function fakeChange(change: () => void): Promise<void> {
    try {
        change();
        return Promise.resolve();
    } catch (error) {
        return Promise.reject(error);
    }
}

const FAKE_PATCH = `diff --git a/src/App.tsx b/src/App.tsx
index 1a2b3c4..5d6e7f8 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,9 +1,11 @@
 import { useEffect } from "react";
-import { Sidebar } from "./layout";
+import { Sidebar, TopBar } from "./layout";
+import { RightSidebar } from "./rightbar";

 export function App() {
     useEffect(() => {
-        document.title = "Hive";
+        // The window's title, as the taskbar shows it.
+        document.title = "Hive Dev";
     }, []);
-    return <Sidebar />;
+    return <TopBar />;
 }
diff --git a/src/rightbar/kinds.ts b/src/rightbar/kinds.ts
index 9f8e7d6..c5b4a39 100644
--- a/src/rightbar/kinds.ts
+++ b/src/rightbar/kinds.ts
@@ -12,3 +12,8 @@ export const NEW_TABS: readonly NewTab[] = [
         open: () => openTerminalTab()
-    }
+    },
+    {
+        label: "Diff",
+        open: () => openDiffTab()
+    }
 ];
diff --git a/notes.md b/notes.md
new file mode 100644
--- /dev/null
+++ b/notes.md
@@ -0,0 +1,3 @@
+# Notes
+
+A made-up diff, shown under \`bun run dev\`.
`;

export const gitApi = {
    repo: (cwd: string): Promise<GitRepo | null> =>
        isTauri ? invoke("git_repo", { cwd }) : Promise.resolve(fakeRepo(cwd)),
    /** The checkout's changes against HEAD, or with `base` against its merge base. */
    diff: (cwd: string, base?: string): Promise<GitDiff | null> =>
        isTauri
            ? invoke("git_diff", { cwd, base: base ?? null })
            : Promise.resolve({
                  root: cwd,
                  branch: fake.current,
                  mergeBase: base ? "1f2e3d4" : undefined,
                  patch: FAKE_PATCH,
                  truncated: false
              }),
    /** What a chat's latest turn changed in its checkout; null before a turn since launch. */
    turnDiff: (chatId: string): Promise<GitDiff | null> =>
        isTauri
            ? invoke("git_turn_diff", { chatId })
            : Promise.resolve({
                  root: "",
                  branch: fake.current,
                  patch: FAKE_PATCH.slice(FAKE_PATCH.indexOf("diff --git a/notes.md")),
                  truncated: false
              }),
    switchBranch: (cwd: string, name: string): Promise<void> =>
        isTauri
            ? invoke("git_switch_branch", { cwd, name })
            : fakeChange(() => {
                  fake.current = name;
              }),
    createBranch: (cwd: string, name: string, from: string): Promise<void> =>
        isTauri
            ? invoke("git_create_branch", { cwd, name, from })
            : fakeChange(() => {
                  if (fake.branches.some((b) => b.name === name)) {
                      throw new Error(`a branch named '${name}' already exists`);
                  }
                  fake.branches.push({ name, subject: "Branched", age: 0 });
                  fake.current = name;
              }),
    deleteBranch: (cwd: string, name: string): Promise<void> =>
        isTauri
            ? invoke("git_delete_branch", { cwd, name })
            : fakeChange(() => {
                  fake.branches = fake.branches.filter((b) => b.name !== name);
              })
};
