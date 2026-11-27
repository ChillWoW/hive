import { currentFolder } from "@/features/changes/open";
import { panelTabs, usePanelTabsStore, type PanelTab } from "@/features/panel-tabs/store";
import { getPanelLayout, useLayoutStore } from "@/layout/store";
import { getHomeDir, tildify } from "@/lib/home";

let home: string | null = null;
void getHomeDir().then((dir) => (home = dir));

/** Brings the tabs panel up if it's away. */
function revealPanel() {
    if (!getPanelLayout().visible.tabs) useLayoutStore.getState().toggle("tabs");
}

const tabs = () => usePanelTabsStore.getState().tabs;

/**
 * Shows `cwd`'s history in a tab, the one already showing it if any. The
 * tab's id; null when there's no folder to show.
 */
export function openHistoryTab(cwd: string | null = currentFolder()): string | null {
    if (!cwd) return null;
    const open = tabs().find((t) => t.kind === "history" && t.history?.cwd === cwd);
    let id: string;
    if (open) {
        id = open.id;
        panelTabs.select(id);
    } else {
        id = panelTabs.open({ kind: "history", title: "History", detail: tildify(cwd, home), history: { cwd } });
    }
    revealPanel();
    return id;
}

const short = (sha: string) => sha.slice(0, 7);

/** A commit tab's title and tooltip; the subject once it's known. */
export function commitTabLabels(cwd: string, sha: string, subject?: string): Pick<PanelTab, "title" | "detail"> {
    return { title: subject?.trim() || short(sha), detail: `${short(sha)} · ${tildify(cwd, home)}` };
}

/**
 * Shows commit `sha` of `cwd`'s checkout in a tab: the one already showing
 * it, else `into` (a tab id), else the folder's commit tab (it moves to this
 * commit, so browsing the history doesn't pile tabs up), else a new one.
 * `fresh` always opens a new one.
 */
export function openCommitTab(
    cwd: string,
    commit: { sha: string; subject?: string },
    { fresh = false, into }: { fresh?: boolean; into?: string } = {}
): string {
    const list = tabs();
    const showing = list.find((t) => t.kind === "commit" && t.commit?.cwd === cwd && t.commit.sha === commit.sha);
    const reused =
        showing ??
        (fresh
            ? undefined
            : (list.find((t) => t.id === into) ?? list.find((t) => t.kind === "commit" && t.commit?.cwd === cwd)));
    const labels = commitTabLabels(cwd, commit.sha, commit.subject);
    let id: string;
    if (reused) {
        id = reused.id;
        if (reused !== showing) panelTabs.update(id, { ...labels, commit: { cwd, sha: commit.sha } });
        panelTabs.select(id);
    } else {
        id = panelTabs.open({ kind: "commit", ...labels, commit: { cwd, sha: commit.sha } });
    }
    revealPanel();
    return id;
}
