import {
    ArrowsInLineVerticalIcon,
    ArrowsOutLineVerticalIcon,
    CloudIcon,
    GitBranchIcon,
    TagIcon
} from "@phosphor-icons/react";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { DARK } from "@/lib/palette";
import type { GitHistoryCommit, GitHistoryRef } from "@/proto";
import { Tooltip } from "@/ui";
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
import { columnWidth, type AuthorDisplay, type HistoryColumn } from "./store";

/*
 * One row of the history tab: its slice of the lane graph (an SVG cell),
 * the subject with ref badges, then the author, date and hash columns.
 */

// Colours: the graph palette at 72% saturation.

function desaturate(hex: string, amount = 0.72) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number
    ];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    if (d) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    const s = (d ? d / (1 - Math.abs(2 * l - 1)) : 0) * amount;
    return `hsl(${Math.round(h * 60 + 360) % 360} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
}

const BLUE = "#6fb3f2";
const VIOLET = "#b39cf0";
const PALETTE = [BLUE, VIOLET, "#a5e075", "#f0a45d", "#ff616e", DARK[200]].map((c) => desaturate(c));
/** The side panels' background (`dark-850`), which dimmed paths fade into. */
const PANEL_BG = DARK[850];
const colorOf = (id: number) => PALETTE[id % PALETTE.length]!;
/** Opaque, so overlapping row seams don't stack into dots. */
const dimmed = (color: string) => `color-mix(in srgb, ${color} 24%, ${PANEL_BG})`;

const STROKE = 1.5;
const HIT_WIDTH = 11;
const UNFOCUSED_ROW_OPACITY = 0.6;

/** Branches as the update button (`info`): local on /20, remote on /10. */
const REF_STYLE: Record<
    GitHistoryRef["kind"],
    { className: string; label: string; Icon: typeof GitBranchIcon }
> = {
    branch: { className: "bg-info/20 text-info", label: "Branch", Icon: GitBranchIcon },
    remote: { className: "bg-info/10 text-info", label: "Remote branch", Icon: CloudIcon },
    tag: { className: "bg-[#f0a45d]/10 text-[#f0a45d]/90", label: "Tag", Icon: TagIcon }
};

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
    columns,
    authorDisplay,
    avatar,
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
    columns: HistoryColumn[];
    authorDisplay: AuthorDisplay;
    avatar: string | undefined;
    fold: Fold | undefined;
    onToggleFold: (ref: GitHistoryRef) => void;
    onGraphHover: (color: number | undefined) => void;
    onRowHover: (color: number | undefined) => void;
    onOpen: () => void;
}) {
    const faded = focus !== undefined && focus !== row.color;
    return (
        <div
            role="button"
            tabIndex={-1}
            onClick={onOpen}
            onMouseEnter={() => onRowHover(row.color)}
            className="flex cursor-pointer items-center text-[11px] transition-colors hover:bg-white/[0.03]"
            style={{ height: ROW_HEIGHT }}
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
                className="flex h-full min-w-0 flex-1 items-center gap-[5px] pr-2 transition-opacity"
                style={{ opacity: faded ? UNFOCUSED_ROW_OPACITY : 1, minWidth: SUBJECT_MIN_WIDTH }}
            >
                <span className="min-w-0 flex-1 truncate text-[12px] text-dark-50">
                    {commit.subject || "(no subject)"}
                </span>
                {commit.refs.length > 0 && <RefBadges refs={commit.refs} width={refWidth} />}
            </div>
            <div
                className="flex h-full shrink-0 transition-opacity"
                style={{ opacity: faded ? UNFOCUSED_ROW_OPACITY : 1 }}
            >
                {columns.map((column) =>
                    column === "author" ? (
                        <AuthorCell
                            key={column}
                            width={columnWidth(column, authorDisplay)}
                            display={authorDisplay}
                            name={commit.authorName.trim() || "Unknown"}
                            avatar={avatar}
                        />
                    ) : column === "date" ? (
                        <DateCell key={column} authoredAt={commit.authoredAt} />
                    ) : (
                        <ShaCell key={column} sha={commit.sha} />
                    )
                )}
            </div>
        </div>
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
    const paint = (id: number) =>
        focus !== undefined && focus !== id ? dimmed(colorOf(id)) : colorOf(id);
    const leave = () => onHover(undefined);
    const mid = ROW_HEIGHT / 2;
    const nodeX = laneX(geometry, geometry.compact ? 0 : row.lane);
    const radius = NODE_RADIUS;
    const color = paint(row.color);

    // The compact rail: each row's half-lines in its node's colour, joining row centres.
    const lines: { d: string; color: number }[] = geometry.compact
        ? [
              ...(previousColor !== undefined
                  ? [{ d: `M${nodeX} ${-ROW_OVERLAP}L${nodeX} ${mid}`, color: previousColor }]
                  : []),
              ...(hasNext
                  ? [{ d: `M${nodeX} ${mid}L${nodeX} ${ROW_HEIGHT + ROW_OVERLAP}`, color: row.color }]
                  : [])
          ]
        : row.segments.map((s) => ({ d: segmentPath(s, geometry), color: s.color }));
    // The focused path on top.
    lines.sort((a, b) => Number(a.color === focus) - Number(b.color === focus));

    return (
        <div
            className="group/graph relative h-full shrink-0"
            style={{ width: geometry.width }}
            onMouseLeave={leave}
        >
            <svg
                width={geometry.width}
                height={ROW_HEIGHT}
                className="absolute inset-0 overflow-visible"
                aria-hidden
            >
                <g fill="none">
                    {lines.map((line, i) => (
                        <path
                            key={i}
                            d={line.d}
                            stroke={paint(line.color)}
                            strokeWidth={STROKE}
                            className="transition-[stroke] duration-150"
                        />
                    ))}
                </g>
                {row.isHead && (
                    <circle
                        cx={nodeX}
                        cy={mid}
                        r={radius + HEAD_RING_PADDING}
                        fill={PANEL_BG}
                        stroke={color}
                        strokeWidth={1}
                    />
                )}
                <circle cx={nodeX} cy={mid} r={radius} fill={color} className="transition-[fill] duration-150" />
                {/* Wider invisible strokes to hover a path by. */}
                <g fill="none" stroke="transparent" strokeWidth={HIT_WIDTH} pointerEvents="stroke">
                    {lines.map((line, i) => (
                        <path
                            key={i}
                            d={line.d}
                            onMouseEnter={() => onHover(line.color)}
                            onMouseLeave={leave}
                        />
                    ))}
                </g>
                <circle
                    cx={nodeX}
                    cy={mid}
                    r={radius + 5.5}
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
                    color={colorOf(row.color)}
                    onToggle={onToggleFold}
                />
            )}
        </div>
    );
}

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
        ? `Expand ${fold.ref.label}${fold.hidden ? ` (${fold.hidden} hidden)` : ""}`
        : `Collapse ${fold.ref.label}`;
    const Icon = fold.folded ? ArrowsOutLineVerticalIcon : ArrowsInLineVerticalIcon;
    return (
        <Tooltip>
            <Tooltip.Trigger
                delay={250}
                render={
                    <button
                        type="button"
                        aria-label={label}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle(fold.ref);
                        }}
                        className={cn(
                            "absolute flex size-4 items-center justify-center rounded-full border outline-none transition-opacity",
                            "group-hover/graph:opacity-100 focus-visible:opacity-100",
                            fold.folded ? "opacity-100" : "opacity-0"
                        )}
                        style={{
                            left,
                            top: (ROW_HEIGHT - 16) / 2,
                            borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
                            background: PANEL_BG,
                            color
                        }}
                    >
                        <Icon className="size-[9px]" weight="bold" />
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{label}</Tooltip.Content>
        </Tooltip>
    );
}

function RefBadges({ refs, width }: { refs: GitHistoryRef[]; width: number }) {
    // Not even one fits whole: the first one truncated, rather than just "+N".
    const count = Math.max(visibleRefCount(refs, width), width >= 48 ? 1 : 0);
    const hidden = refs.slice(count);
    const describe = (r: GitHistoryRef) => `${REF_STYLE[r.kind].label}: ${r.label}`;
    return (
        <div className="flex min-w-0 shrink-0 items-center overflow-hidden" style={{ maxWidth: width, gap: REF_GAP }}>
            {refs.slice(0, count).map((ref) => {
                const { className, Icon } = REF_STYLE[ref.kind];
                return (
                    <Tooltip key={`${ref.kind}:${ref.label}`}>
                        <Tooltip.Trigger
                            delay={350}
                            render={
                                <span
                                    className={cn(
                                        "flex h-[18px] min-w-0 max-w-28 shrink items-center gap-0.5 rounded px-[5px] text-[10px]",
                                        className
                                    )}
                                >
                                    <Icon className="size-2.5 shrink-0 opacity-80" />
                                    <span className="min-w-0 truncate">{ref.label}</span>
                                </span>
                            }
                        />
                        <Tooltip.Content side="bottom" className="font-mono">
                            {describe(ref)}
                        </Tooltip.Content>
                    </Tooltip>
                );
            })}
            {hidden.length > 0 && (
                <Tooltip>
                    <Tooltip.Trigger
                        delay={350}
                        render={<span className="shrink-0 text-[10px] text-dark-250">+{hidden.length}</span>}
                    />
                    <Tooltip.Content side="bottom" className="font-mono">
                        {hidden.map((r) => (
                            <div key={`${r.kind}:${r.label}`}>{describe(r)}</div>
                        ))}
                    </Tooltip.Content>
                </Tooltip>
            )}
        </div>
    );
}

function AuthorCell({
    width,
    display,
    name,
    avatar
}: {
    width: number;
    display: AuthorDisplay;
    name: string;
    avatar: string | undefined;
}) {
    if (display === "name") {
        return (
            <div className="flex h-full items-center truncate pr-2 text-dark-200" style={{ width }}>
                <span className="truncate">{name}</span>
            </div>
        );
    }
    const initial = [...name][0]?.toUpperCase() ?? "?";
    return (
        <div className="flex h-full items-center justify-center" style={{ width }}>
            <Tooltip>
                <Tooltip.Trigger
                    delay={300}
                    render={
                        <span className="flex size-5 items-center justify-center overflow-hidden rounded-full border border-white/[0.12] bg-white/[0.08] text-[9px] text-dark-250">
                            {avatar ? (
                                <img src={avatar} alt="" className="size-full object-cover" draggable={false} />
                            ) : (
                                initial
                            )}
                        </span>
                    }
                />
                <Tooltip.Content side="bottom">{name}</Tooltip.Content>
            </Tooltip>
        </div>
    );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function DateCell({ authoredAt }: { authoredAt: string }) {
    const date = new Date(authoredAt);
    const valid = !Number.isNaN(date.getTime());
    return (
        <div className="flex h-full w-[88px] items-center pr-2 text-[10.5px] text-dark-200">
            {valid ? (
                <Tooltip>
                    <Tooltip.Trigger
                        delay={500}
                        render={<span className="truncate">{dateFormat.format(date)}</span>}
                    />
                    <Tooltip.Content side="bottom">{fullDateFormat.format(date)}</Tooltip.Content>
                </Tooltip>
            ) : (
                "—"
            )}
        </div>
    );
}

function ShaCell({ sha }: { sha: string }) {
    const [copied, copy] = useCopy(1200);
    return (
        <div className="flex h-full w-[74px] items-center pr-1.5">
            <button
                type="button"
                aria-label="Copy the hash"
                onClick={(e) => {
                    e.stopPropagation();
                    copy(sha);
                }}
                className={cn(
                    "flex h-6 w-full items-center rounded px-1 font-mono text-[10.5px] outline-none hover:bg-white/[0.07] focus-visible:bg-white/[0.07]",
                    copied ? "text-info" : "text-dark-200"
                )}
            >
                {copied ? "Copied" : sha.slice(0, 7)}
            </button>
        </div>
    );
}
