import type { GitHistoryCommit, GitHistoryRef } from "@/proto";

/**
 * The history tab's lane graph, as zeron's `history.rs`: commits come
 * children first (`git log --topo-order`); each active lane points at the
 * parent that will end it. A row's segments are drawn in that row's band:
 * lanes passing through, lanes ending in its node, and lanes leaving it.
 */

export type SegmentShape = "through" | "incoming" | "outgoing";

export type GraphSegment = { from: number; to: number; color: number; shape: SegmentShape };

export type GraphRow = {
    sha: string;
    lane: number;
    /** The node's colour id, also its path's identity for hover focus. */
    color: number;
    segments: GraphSegment[];
    isHead: boolean;
};

export type GraphLayout = { rows: GraphRow[]; laneCount: number };

type Lane = { id: number; color: number; target: string };

const indexOfLane = (lanes: Lane[], id: number) => lanes.findIndex((l) => l.id === id);

export function layoutGraph(
    commits: readonly GitHistoryCommit[],
    headSha: string | undefined
): GraphLayout {
    let active: Lane[] = [];
    let nextLane = 0;
    let nextColor = 0;
    let laneCount = 0;
    const rows: GraphRow[] = [];

    for (const commit of commits) {
        const before = active;
        const incoming: number[] = [];
        before.forEach((lane, i) => {
            if (lane.target === commit.sha) incoming.push(i);
        });
        const primary = incoming.length > 0 ? before[incoming[0]!] : undefined;
        const nodeLane = incoming[0] ?? before.length;
        const color = primary ? primary.color : nextColor++;
        const resolved = new Set(incoming.map((i) => before[i]!.id));
        const next = before.filter((l) => !resolved.has(l.id));
        const outgoing: [id: number, color: number][] = [];

        let primaryOut: number | undefined;
        const first = commit.parentShas[0];
        if (first !== undefined) {
            const id = primary ? primary.id : nextLane++;
            next.splice(Math.min(nodeLane, next.length), 0, { id, color, target: first });
            primaryOut = id;
            outgoing.push([id, color]);
        }
        let offset = 1;
        for (const parent of commit.parentShas.slice(1)) {
            const existing = next.find((l) => l.target === parent);
            if (existing) {
                outgoing.push([existing.id, existing.color]);
                continue;
            }
            const lane = { id: nextLane++, color: nextColor++, target: parent };
            const at =
                primaryOut !== undefined
                    ? indexOfLane(next, primaryOut)
                    : Math.min(nodeLane, next.length);
            next.splice(Math.min(at + offset, next.length), 0, lane);
            offset++;
            outgoing.push([lane.id, lane.color]);
        }

        const segments: GraphSegment[] = [];
        before.forEach((lane, from) => {
            if (resolved.has(lane.id)) return;
            segments.push({ from, to: indexOfLane(next, lane.id), color: lane.color, shape: "through" });
        });
        for (const from of incoming) {
            segments.push({ from, to: nodeLane, color: before[from]!.color, shape: "incoming" });
        }
        for (const [id, c] of outgoing) {
            segments.push({ from: nodeLane, to: indexOfLane(next, id), color: c, shape: "outgoing" });
        }

        laneCount = Math.max(laneCount, before.length, next.length, nodeLane + 1);
        rows.push({ sha: commit.sha, lane: nodeLane, color, segments, isHead: commit.sha === headSha });
        active = next;
    }
    return { rows, laneCount };
}

/**
 * The `visible` commits in order, each parent outside the set replaced by its
 * nearest visible ancestors; a parent that isn't listed (not loaded yet)
 * stays as is. Mirrors `compact_to_visible` in `crates/git/src/history.rs`.
 */
export function compactToVisible(
    commits: readonly GitHistoryCommit[],
    visible: ReadonlySet<string>
): GitHistoryCommit[] {
    const listed = new Set(commits.map((c) => c.sha));
    const resolved = new Map<string, string[]>();
    const lift = (commit: GitHistoryCommit) => {
        const out = new Set<string>();
        for (const parent of commit.parentShas) {
            if (visible.has(parent) || !listed.has(parent)) out.add(parent);
            else for (const sha of resolved.get(parent) ?? []) out.add(sha);
        }
        return [...out];
    };
    // Parents come after their children, so backwards each hidden commit's
    // parents are resolved before it.
    for (let i = commits.length - 1; i >= 0; i--) {
        const commit = commits[i]!;
        if (!visible.has(commit.sha)) resolved.set(commit.sha, lift(commit));
    }
    return commits.filter((c) => visible.has(c.sha)).map((c) => ({ ...c, parentShas: lift(c) }));
}

/** The search's match, as `history_matches` in `crates/git/src/history.rs`. */
export function historyMatches(query: string, commit: GitHistoryCommit): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (commit.sha.startsWith(q)) return true;
    const haystack = `${commit.sha} ${commit.subject}`.toLowerCase();
    return q.split(/\s+/).every((term) => {
        let at = 0;
        for (const ch of term) {
            const found = haystack.indexOf(ch, at);
            if (found === -1) return false;
            at = found + ch.length;
        }
        return true;
    });
}

/** A branch's identity for folding (`local:main`, `remote:origin/main`); tags don't fold. */
export function branchRefKey(ref: GitHistoryRef): string | undefined {
    if (ref.kind === "tag") return undefined;
    return `${ref.kind === "branch" ? "local" : "remote"}:${ref.label}`;
}

/**
 * Hides the straight runs of the folded branches' lanes, keeping their tips,
 * other refs, roots, merges and branch points; parents are carried across
 * what's hidden. Also how many commits each folded branch hides.
 */
export function collapseBranchRuns(
    commits: readonly GitHistoryCommit[],
    folded: ReadonlySet<string>,
    headSha: string | undefined
): { commits: readonly GitHistoryCommit[]; hidden: Map<string, number> } {
    const hidden = new Map<string, number>();
    if (folded.size === 0 || commits.length === 0) return { commits, hidden };

    const source = layoutGraph(commits, headSha);
    const colorByRef = new Map<string, number>();
    commits.forEach((commit, i) => {
        for (const ref of commit.refs) {
            const key = branchRefKey(ref);
            if (key && folded.has(key)) colorByRef.set(key, source.rows[i]!.color);
        }
    });
    if (colorByRef.size === 0) return { commits, hidden };

    const foldedColors = new Set(colorByRef.values());
    const children = new Map<string, number>();
    for (const commit of commits) {
        for (const parent of commit.parentShas) children.set(parent, (children.get(parent) ?? 0) + 1);
    }
    const visible = new Set<string>();
    commits.forEach((commit, i) => {
        const color = source.rows[i]!.color;
        const junction = commit.parentShas.length !== 1 || (children.get(commit.sha) ?? 0) > 1;
        if (foldedColors.has(color) && commit.refs.length === 0 && !junction) {
            for (const [key, c] of colorByRef) {
                if (c === color) hidden.set(key, (hidden.get(key) ?? 0) + 1);
            }
        } else {
            visible.add(commit.sha);
        }
    });
    return { commits: compactToVisible(commits, visible), hidden };
}

// Geometry (zeron's `GraphGeometry`).

export const ROW_HEIGHT = 36;
export const NODE_RADIUS = 3;
export const HEAD_RING_PADDING = 2;
export const ROW_OVERLAP = 0.75;
const LANE_SPACING = 12;
/** The first lane's centre lines up with the header's text. */
const SIDE_PADDING = 13;
const TRAILING_PADDING = 12;
const MIN_COMPACT_WIDTH = 48;
/** The graph never takes more than this share of the tab. */
const MAX_WIDTH_RATIO = 0.34;
export const SUBJECT_MIN_WIDTH = 80;
const COMPACT_ENTER_SUBJECT = 160;
const COMPACT_EXIT_SUBJECT = 184;
const COMPACT_ENTER_SPACING = 4;
const COMPACT_EXIT_SPACING = 5;

export type Geometry = { width: number; spacing: number; compact: boolean };

const FIXED_WIDTH = SIDE_PADDING + TRAILING_PADDING + NODE_RADIUS * 2;

function natural(lanes: number): Geometry {
    const n = Math.max(1, lanes);
    return { width: FIXED_WIDTH + (n - 1) * LANE_SPACING, spacing: LANE_SPACING, compact: false };
}

function fitted(lanes: number, width: number): Geometry {
    const n = Math.max(1, lanes);
    const full = natural(n);
    if (n === 1 || width >= full.width) return full;
    const w = Math.min(Math.max(width, FIXED_WIDTH), full.width);
    return { width: w, spacing: (w - FIXED_WIDTH) / (n - 1), compact: false };
}

/**
 * The graph's width for `lanes` lanes in a tab `width` wide: natural spacing
 * when it fits, else squeezed so the subject keeps its room, else (or when
 * lanes would nearly touch) a one-lane rail. `wasCompact` gives hysteresis.
 */
export function graphGeometry(
    lanes: number,
    width: number,
    columnsWidth: number,
    wasCompact: boolean
): Geometry {
    const full = natural(lanes);
    if (full.width <= MIN_COMPACT_WIDTH) return full;
    const contentBudget = Math.max(width - columnsWidth - SUBJECT_MIN_WIDTH, MIN_COMPACT_WIDTH);
    const shareBudget = Math.max(width * MAX_WIDTH_RATIO, MIN_COMPACT_WIDTH);
    const target = fitted(lanes, Math.floor(Math.min(full.width, contentBudget, shareBudget)));
    if (lanes > 1) {
        const subject = width - columnsWidth - target.width;
        const compact = wasCompact
            ? subject < COMPACT_EXIT_SUBJECT || target.spacing < COMPACT_EXIT_SPACING
            : subject < COMPACT_ENTER_SUBJECT || target.spacing < COMPACT_ENTER_SPACING;
        if (compact) return { ...natural(1), spacing: 0, compact: true };
    }
    return target;
}

export const laneX = (g: Geometry, lane: number) => SIDE_PADDING + NODE_RADIUS + lane * g.spacing;

// Ref badges.

const REF_BADGE_MAX_WIDTH = 112;
export const REF_GAP = 5;
const REF_AREA_RATIO = 0.45;

const badgeWidth = (ref: GitHistoryRef) => Math.min(22 + ref.label.length * 5.7, REF_BADGE_MAX_WIDTH);

/** Room for ref badges in a commit cell `cellWidth` wide: under half, never the subject's minimum. */
export function refAreaWidth(cellWidth: number) {
    const inner = Math.max(cellWidth - 8, 0);
    return Math.min(inner * REF_AREA_RATIO, Math.max(inner - SUBJECT_MIN_WIDTH - REF_GAP, 0));
}

/** How many badges fit in `width`, leaving room for a "+N" when some don't. */
export function visibleRefCount(refs: readonly GitHistoryRef[], width: number) {
    let visible = 0;
    let badges = 0;
    for (let count = 1; count <= refs.length; count++) {
        badges += badgeWidth(refs[count - 1]!);
        const hidden = refs.length - count;
        const overflow = hidden > 0 ? `+${hidden}`.length * 5.7 : 0;
        const gaps = (count + (hidden > 0 ? 1 : 0) - 1) * REF_GAP;
        if (badges + overflow + gaps <= width) visible = count;
    }
    return visible;
}
