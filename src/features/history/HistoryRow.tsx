import type { MouseEvent } from "react";
import { ArrowsInLineVerticalIcon, ArrowsOutLineVerticalIcon } from "@phosphor-icons/react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/time";
import type { GitHistoryCommit, GitHistoryRef } from "@/proto";
import { ContextMenu, Tooltip } from "@/ui";
import {
    HEAD_RING_PADDING,
    laneX,
    NODE_RADIUS,
    REF_GAP,
    ROW_HEIGHT,
    ROW_OVERLAP,
    SUBJECT_MIN_WIDTH,
    visibleRefCount,
    type Geometry,
    type GraphRow,
    type GraphSegment
} from "./graph";
import { describeRef, dimmedLane, formatDay, formatFull, laneColor, parseTime } from "./display";
import { AuthorAvatar, RefBadge } from "./parts";

/*
 * One row of the history tab: its slice of the lane graph (an SVG cell), the
 * subject with ref badges, then the author, hash and age. The author's name
 * and the hash show once the tab is wide enough.
 */

const STROKE = 1.5;
/** Hovering a line this close to it focuses its path. */
const HIT_WIDTH = 11;
const FADED_OPACITY = 0.55;

export type Fold = { ref: GitHistoryRef; folded: boolean; hidden: number };

export function HistoryRow({
    commit,
    row,
    previousColor,
    hasNext,
    rail,
    geometry,
    focus,
    refWidth,
    currentBranch,
    avatar,
    now,
    open,
    fold,
    onToggleFold,
    onGraphHover,
    onRowHover,
    onOpen
}: {
    commit: GitHistoryCommit;
    row: GraphRow;
    previousColor: number | undefined;
    hasNext: boolean;
    /** In the one-lane rail, join rows (not in the tips view: they aren't related). */
    rail: boolean;
    geometry: Geometry;
    focus: number | undefined;
    refWidth: number;
    currentBranch: string | undefined;
    avatar: string | undefined;
    now: number;
    /** Shown in a commit tab. */
    open: boolean;
    fold: Fold | undefined;
    onToggleFold: (ref: GitHistoryRef) => void;
    onGraphHover: (color: number | undefined) => void;
    onRowHover: (color: number | undefined) => void;
    onOpen: (fresh: boolean) => void;
}) {
    const faded = focus !== undefined && focus !== row.color;
    const author = commit.authorName.trim() || "Unknown";
    const at = parseTime(commit.authoredAt);

    return (
        <ContextMenu>
            <ContextMenu.Trigger
                role="button"
                tabIndex={-1}
                onClick={(event: MouseEvent) => onOpen(event.metaKey || event.ctrlKey)}
                onAuxClick={(event: MouseEvent) => event.button === 1 && onOpen(true)}
                // Middle-click would otherwise start autoscroll.
                onMouseDown={(event: MouseEvent) => event.button === 1 && event.preventDefault()}
                onMouseEnter={() => onRowHover(row.color)}
                style={{ height: ROW_HEIGHT }}
                className={cn(
                    "flex cursor-default items-center bg-(--row-bg) text-xs transition-colors duration-100",
                    open
                        ? "[--row-bg:var(--color-hover)]"
                        : "[--row-bg:var(--color-bg)] hover:[--row-bg:var(--color-raised)] data-[popup-open]:[--row-bg:var(--color-raised)]"
                )}
            >
                <GraphCell
                    row={row}
                    previousColor={rail ? previousColor : undefined}
                    hasNext={rail && hasNext}
                    geometry={geometry}
                    focus={focus}
                    fold={fold}
                    onToggleFold={onToggleFold}
                    onHover={onGraphHover}
                />
                <div
                    className="flex h-full min-w-0 flex-1 items-center gap-2 pr-2 transition-opacity duration-150"
                    style={{ opacity: faded ? FADED_OPACITY : 1, minWidth: SUBJECT_MIN_WIDTH }}
                >
                    <span className={cn("min-w-0 flex-1 truncate", commit.subject ? "text-text" : "text-muted italic")}>
                        {commit.subject || "No message"}
                    </span>
                    {commit.refs.length > 0 && (
                        <RefBadges refs={commit.refs} width={refWidth} currentBranch={currentBranch} />
                    )}
                </div>
                <div
                    className="flex h-full shrink-0 items-center gap-2 pr-3 text-muted transition-opacity duration-150"
                    style={{ opacity: faded ? FADED_OPACITY : 1 }}
                >
                    <Tooltip disableHoverablePopup>
                        <Tooltip.Trigger
                            delay={400}
                            render={
                                <span className="flex min-w-0 items-center gap-1.5">
                                    <AuthorAvatar name={author} url={avatar} />
                                    <span className="hidden w-24 truncate @[36rem]:block">{author}</span>
                                </span>
                            }
                        />
                        <Tooltip.Content side="bottom">
                            {author}
                            {commit.authorEmail && <span className="text-muted"> · {commit.authorEmail}</span>}
                        </Tooltip.Content>
                    </Tooltip>
                    <span className="hidden w-14 font-mono text-[11px] @[44rem]:block">{commit.sha.slice(0, 7)}</span>
                    <Tooltip disableHoverablePopup disabled={at === undefined}>
                        <Tooltip.Trigger
                            delay={400}
                            render={
                                <span className="w-8 text-right tabular-nums">
                                    {at === undefined ? "—" : timeAgo(at, now)}
                                </span>
                            }
                        />
                        <Tooltip.Content side="bottom">{at !== undefined && formatFull(at)}</Tooltip.Content>
                    </Tooltip>
                </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content className="w-48 min-w-0">
                <ContextMenu.Item onClick={() => onOpen(false)}>Open commit</ContextMenu.Item>
                <ContextMenu.Item onClick={() => onOpen(true)}>Open in a new tab</ContextMenu.Item>
                <ContextMenu.Separator />
                <ContextMenu.Item onClick={() => void copyText(commit.sha)}>Copy hash</ContextMenu.Item>
                <ContextMenu.Item onClick={() => void copyText(commit.subject)}>Copy message</ContextMenu.Item>
                {at !== undefined && (
                    <ContextMenu.Item onClick={() => void copyText(formatDay(at))}>Copy date</ContextMenu.Item>
                )}
            </ContextMenu.Content>
        </ContextMenu>
    );
}

function segmentPath(s: GraphSegment, g: Geometry) {
    const mid = ROW_HEIGHT / 2;
    const top = -ROW_OVERLAP;
    const bottom = ROW_HEIGHT + ROW_OVERLAP;
    const x1 = laneX(g, s.from);
    const x2 = laneX(g, s.to);
    if (s.shape === "incoming") {
        return `M${x1} ${top}C${x1} ${mid * 0.55} ${x2} ${mid * 0.55} ${x2} ${mid}`;
    }
    if (s.shape === "outgoing") {
        return `M${x1} ${mid}C${x1} ${mid * 1.45} ${x2} ${mid * 1.45} ${x2} ${bottom}`;
    }
    if (x1 === x2) return `M${x1} ${top}L${x2} ${bottom}`;
    return `M${x1} ${top}C${x1} ${mid} ${x2} ${mid} ${x2} ${bottom}`;
}

function GraphCell({
    row,
    previousColor,
    hasNext,
    geometry,
    focus,
    fold,
    onToggleFold,
    onHover
}: {
    row: GraphRow;
    previousColor: number | undefined;
    hasNext: boolean;
    geometry: Geometry;
    focus: number | undefined;
    fold: Fold | undefined;
    onToggleFold: (ref: GitHistoryRef) => void;
    onHover: (color: number | undefined) => void;
}) {
    const paint = (id: number) => (focus !== undefined && focus !== id ? dimmedLane(id) : laneColor(id));
    const leave = () => onHover(undefined);
    const mid = ROW_HEIGHT / 2;
    const nodeX = laneX(geometry, geometry.compact ? 0 : row.lane);
    const color = paint(row.color);

    // The compact rail: each row's half-lines in its node's colour, joining row centres.
    const lines: { d: string; color: number }[] = geometry.compact
        ? [
              ...(previousColor !== undefined
                  ? [{ d: `M${nodeX} ${-ROW_OVERLAP}L${nodeX} ${mid}`, color: previousColor }]
                  : []),
              ...(hasNext ? [{ d: `M${nodeX} ${mid}L${nodeX} ${ROW_HEIGHT + ROW_OVERLAP}`, color: row.color }] : [])
          ]
        : row.segments.map((s) => ({ d: segmentPath(s, geometry), color: s.color }));
    // The focused path on top.
    lines.sort((a, b) => Number(a.color === focus) - Number(b.color === focus));

    return (
        <div className="group/graph relative h-full shrink-0" style={{ width: geometry.width }} onMouseLeave={leave}>
            <svg width={geometry.width} height={ROW_HEIGHT} className="absolute inset-0 overflow-visible" aria-hidden>
                <g fill="none">
                    {lines.map((line, i) => (
                        <path
                            key={i}
                            d={line.d}
                            style={{ stroke: paint(line.color) }}
                            strokeWidth={STROKE}
                            className="transition-[stroke] duration-150"
                        />
                    ))}
                </g>
                {row.isHead && (
                    <circle
                        cx={nodeX}
                        cy={mid}
                        r={NODE_RADIUS + HEAD_RING_PADDING}
                        style={{ fill: "var(--row-bg)", stroke: color }}
                        strokeWidth={1.25}
                    />
                )}
                <circle
                    cx={nodeX}
                    cy={mid}
                    r={NODE_RADIUS}
                    style={{ fill: color }}
                    className="transition-[fill] duration-150"
                />
                {/* Wider invisible strokes to hover a path by. */}
                <g fill="none" stroke="transparent" strokeWidth={HIT_WIDTH} pointerEvents="stroke">
                    {lines.map((line, i) => (
                        <path key={i} d={line.d} onMouseEnter={() => onHover(line.color)} onMouseLeave={leave} />
                    ))}
                </g>
                <circle
                    cx={nodeX}
                    cy={mid}
                    r={NODE_RADIUS + 5.5}
                    fill="transparent"
                    pointerEvents="all"
                    onMouseEnter={() => onHover(row.color)}
                    onMouseLeave={leave}
                />
            </svg>
            {fold && (
                <FoldButton
                    fold={fold}
                    left={nodeX + NODE_RADIUS + 3}
                    color={laneColor(row.color)}
                    onToggle={onToggleFold}
                />
            )}
        </div>
    );
}

/** On a branch's tip: folds its straight run of commits away, or back. */
function FoldButton({
    fold,
    left,
    color,
    onToggle
}: {
    fold: Fold;
    left: number;
    color: string;
    onToggle: (ref: GitHistoryRef) => void;
}) {
    const label = fold.folded
        ? `Unfold ${fold.ref.label}${fold.hidden ? ` (${fold.hidden} hidden)` : ""}`
        : `Fold ${fold.ref.label}`;
    const Glyph = fold.folded ? ArrowsOutLineVerticalIcon : ArrowsInLineVerticalIcon;
    return (
        <Tooltip>
            <Tooltip.Trigger
                delay={250}
                render={
                    <button
                        type="button"
                        aria-label={label}
                        onClick={(event) => {
                            event.stopPropagation();
                            onToggle(fold.ref);
                        }}
                        className={cn(
                            "absolute flex size-4 items-center justify-center rounded-full border bg-(--row-bg) outline-none",
                            "transition-opacity duration-150 group-hover/graph:opacity-100 focus-visible:opacity-100",
                            fold.folded ? "opacity-100" : "opacity-0"
                        )}
                        style={{
                            left,
                            top: (ROW_HEIGHT - 16) / 2,
                            borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
                            color
                        }}
                    >
                        <Glyph className="size-[9px]" weight="bold" />
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{label}</Tooltip.Content>
        </Tooltip>
    );
}

function RefBadges({
    refs,
    width,
    currentBranch
}: {
    refs: GitHistoryRef[];
    width: number;
    currentBranch: string | undefined;
}) {
    // Not even one fits whole: the first one truncated, rather than just "+N".
    const count = Math.max(visibleRefCount(refs, width), width >= 48 ? 1 : 0);
    const hidden = refs.slice(count);
    return (
        <div className="flex min-w-0 shrink-0 items-center overflow-hidden" style={{ maxWidth: width, gap: REF_GAP }}>
            {refs.slice(0, count).map((ref) => (
                <RefBadge
                    key={`${ref.kind}:${ref.label}`}
                    gitRef={ref}
                    current={ref.kind === "branch" && ref.label === currentBranch}
                />
            ))}
            {hidden.length > 0 && (
                <Tooltip disableHoverablePopup>
                    <Tooltip.Trigger
                        delay={400}
                        render={<span className="shrink-0 text-[11px] text-muted">+{hidden.length}</span>}
                    />
                    <Tooltip.Content side="bottom">
                        {hidden.map((r) => (
                            <div key={`${r.kind}:${r.label}`}>{describeRef(r)}</div>
                        ))}
                    </Tooltip.Content>
                </Tooltip>
            )}
        </div>
    );
}
