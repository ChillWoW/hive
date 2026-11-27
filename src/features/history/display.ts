import { CloudIcon, GitBranchIcon, TagIcon } from "@phosphor-icons/react";
import type { GitHistoryRef } from "@/proto";

/** How the history and commit tabs draw things: lane colours, ref kinds, times. */

/**
 * Lane colours, from the theme: its status colours and a violet between info
 * and danger, softened toward `muted` so the graph doesn't shout over the text.
 */
const LANES = [
    "var(--info)",
    "color-mix(in oklch, var(--info), var(--danger))",
    "var(--success)",
    "var(--warning)",
    "var(--danger)",
    "var(--muted)"
].map((c) => `color-mix(in oklch, ${c} 82%, var(--muted))`);

export const laneColor = (id: number) => LANES[id % LANES.length]!;

/** A lane out of focus: faded into the row's background, opaque so seams don't stack. */
export const dimmedLane = (id: number) => `color-mix(in srgb, ${laneColor(id)} 26%, var(--row-bg, var(--bg)))`;

export const REF_KIND: Record<GitHistoryRef["kind"], { label: string; className: string; Icon: typeof GitBranchIcon }> = {
    branch: { label: "Branch", className: "bg-info/15 text-info", Icon: GitBranchIcon },
    remote: { label: "Remote branch", className: "bg-info/[0.07] text-info/80", Icon: CloudIcon },
    tag: { label: "Tag", className: "bg-warning/12 text-warning", Icon: TagIcon }
};

export const describeRef = (ref: GitHistoryRef) => `${REF_KIND[ref.kind].label} ${ref.label}`;

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

/** An RFC 3339 time as milliseconds; undefined when it doesn't parse. */
export function parseTime(at: string): number | undefined {
    const ms = new Date(at).getTime();
    return Number.isNaN(ms) ? undefined : ms;
}

export const formatDay = (ms: number) => dayFormat.format(ms);
export const formatFull = (ms: number) => fullFormat.format(ms);
