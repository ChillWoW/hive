import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/platform";
import type { GitDiff, GitHistoryCommit, GitHistoryPage } from "@/proto";
import { compactToVisible, historyMatches } from "./graph";

/** A page of history is this many commits. */
export const PAGE_SIZE = 100;

/**
 * Transport for the history tab (`src-tauri/src/git.rs`, `avatars.rs`).
 * Under a plain `bun run dev` every folder has the same made-up history.
 */
export const historyApi = {
    /** `PAGE_SIZE` commits from `cursor` on; null outside a checkout. */
    page: (cwd: string, cursor: number): Promise<GitHistoryPage | null> =>
        isTauri
            ? invoke("git_history", { cwd, cursor, limit: PAGE_SIZE })
            : Promise.resolve(fakePage(cursor)),
    /** The commits matching `query` through all of the history, a page at a time. */
    search: (cwd: string, query: string, cursor: number): Promise<GitHistoryPage | null> =>
        isTauri
            ? invoke("git_search_history", { cwd, query, cursor, limit: PAGE_SIZE })
            : delay(fakeSearch(query, cursor), 120),
    /** `git fetch --all`. */
    fetchAll: (cwd: string): Promise<void> =>
        isTauri ? invoke("git_fetch_all", { cwd }) : delay(undefined, 900),
    /** What one commit changed, against its first parent. */
    commitDiff: (cwd: string, sha: string): Promise<GitDiff | null> =>
        isTauri
            ? invoke("git_commit_diff", { cwd, sha })
            : Promise.resolve({ root: cwd, patch: FAKE_COMMIT_PATCH, truncated: false }),
    /** GitHub pictures of a page's authors, as `data:` URLs by lowercased email. */
    avatars: (
        cwd: string,
        authors: { sha: string; email: string }[],
        cursor: number
    ): Promise<Record<string, string>> =>
        isTauri
            ? invoke("git_avatars", { cwd, authors, cursor, limit: PAGE_SIZE })
            : Promise.resolve({})
};

const delay = <T>(value: T, ms: number) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

// The made-up history.

const HOUR = 60 * 60 * 1000;
const AUTHORS = [
    ["ChillWoW", "chill@example.com"],
    ["Ada Lovelace", "ada@example.com"],
    ["Linus", "linus@example.com"]
] as const;
const SUBJECTS = [
    "feat: add the history tab",
    "fix: keep the open chat in view",
    "chore: bump dependencies",
    "refactor: split the diff store",
    "feat: branch picker",
    "fix: terminal resize on Windows",
    "docs: explain worktrees",
    "style: lighten muted text",
    "perf: reuse parsed diff sections",
    "test: cover queued prompts"
];

let fakeCommits: GitHistoryCommit[] | undefined;

/** ~250 commits: a main line with a side branch merged every so often, children first. */
function fakeHistory(): GitHistoryCommit[] {
    if (fakeCommits) return fakeCommits;
    const made: GitHistoryCommit[] = [];
    let time = Date.now() - 400 * HOUR;
    let n = 0;
    const make = (parents: string[], subject: string) => {
        const sha = Array.from({ length: 5 }, (_, i) =>
            (((n + 1) * 2654435761 + i * 40503) >>> 0).toString(16).padStart(8, "0")
        ).join("");
        const [name, email] = AUTHORS[n % AUTHORS.length]!;
        n++;
        time += HOUR * (0.5 + (n % 3));
        made.push({
            sha,
            parentShas: parents,
            subject,
            authorName: name,
            authorEmail: email,
            authoredAt: new Date(time).toISOString(),
            refs: []
        });
        return sha;
    };
    let main = make([], "chore: initial commit");
    let side: string | undefined;
    for (let i = 1; i < 200; i++) {
        const step = i % 12;
        const subject = SUBJECTS[i % SUBJECTS.length]!;
        if (step === 3) side = main;
        if (side && step >= 4 && step <= 7) {
            side = make([side], `${subject} (feat/part-${Math.floor(i / 12)})`);
            if (step % 2 === 0) main = make([main], subject);
        } else if (side && step === 8) {
            main = make([main, side], `Merge branch 'feat/part-${Math.floor(i / 12)}'`);
            side = undefined;
        } else {
            main = make([main], subject);
        }
    }
    const fork = main;
    main = make([main], "fix: sidebar scroll");
    const behind = main;
    main = make([main], "feat: fetch all");
    let open = make([fork], "wip: history graph");
    open = make([open], "wip: lane colours");

    const commits = made.reverse();
    const at = (sha: string) => commits.find((c) => c.sha === sha)!;
    at(main).refs.push({ kind: "branch", label: "main" });
    at(behind).refs.push({ kind: "remote", label: "origin/main" });
    at(open).refs.push({ kind: "branch", label: "feat/git-history" });
    at(commits[12]!.sha).refs.push({ kind: "tag", label: "v0.0.3" });
    fakeCommits = commits;
    return commits;
}

/** `main` is checked out. */
const fakeHead = () => fakeHistory().find((c) => c.refs.some((r) => r.label === "main"))!.sha;

function fakePage(cursor: number): GitHistoryPage {
    const all = fakeHistory();
    const commits = all.slice(cursor, cursor + PAGE_SIZE);
    const first = cursor === 0;
    const end = cursor + commits.length;
    return {
        commits,
        branchTips: first ? all.filter((c) => c.refs.some((r) => r.kind !== "tag")) : [],
        headSha: fakeHead(),
        nextCursor: end < all.length ? end : undefined,
        totalCount: first ? all.length : undefined,
        headCommitCount: first ? all.length - 2 : undefined,
        comparison: first ? { base: "origin/main", ahead: 1, behind: 0 } : undefined
    };
}

function fakeSearch(query: string, cursor: number): GitHistoryPage {
    const all = fakeHistory();
    const visible = new Set(all.filter((c) => historyMatches(query, c)).map((c) => c.sha));
    const matches = compactToVisible(all, visible);
    const commits = matches.slice(cursor, cursor + PAGE_SIZE);
    const end = cursor + commits.length;
    return {
        commits,
        branchTips: [],
        headSha: fakeHead(),
        nextCursor: end < matches.length ? end : undefined,
        totalCount: matches.length
    };
}

const FAKE_COMMIT_PATCH = `diff --git a/src/history/graph.ts b/src/history/graph.ts
new file mode 100644
--- /dev/null
+++ b/src/history/graph.ts
@@ -0,0 +1,4 @@
+/** The history tab's lane graph. */
+export function layoutGraph() {
+    return { rows: [], laneCount: 0 };
+}
diff --git a/src/rightbar/kinds.ts b/src/rightbar/kinds.ts
index 9f8e7d6..c5b4a39 100644
--- a/src/rightbar/kinds.ts
+++ b/src/rightbar/kinds.ts
@@ -1,3 +1,4 @@
 import { openDiffTab } from "./actions";
+import { openHistoryTab } from "./actions";

 export const NEW_TABS = [];
`;
