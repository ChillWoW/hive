import { invoke } from "@tauri-apps/api/core";
import type { GitBranch, GitRepo } from "@/proto";
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
        { name: "fix/sidebar-scroll", subject: "fix: keep the open chat in view", age: 30 }
    ]
};

function fakeRepo(): GitRepo {
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
            subject: b.subject
        }))
        .sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));
    return { branch: fake.current, commit: "5c93f90", branches };
}

function fakeChange(change: () => void): Promise<void> {
    try {
        change();
        return Promise.resolve();
    } catch (error) {
        return Promise.reject(error);
    }
}

export const gitApi = {
    repo: (cwd: string): Promise<GitRepo | null> =>
        isTauri ? invoke("git_repo", { cwd }) : Promise.resolve(fakeRepo()),
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
