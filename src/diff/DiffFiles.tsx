import { Fragment, memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
    ArrowCounterClockwiseIcon,
    ArrowSquareOutIcon,
    CaretRightIcon,
    PlusIcon
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { lineRef, refKey } from "@/review/comments";
import { FileIcon, IconButton } from "@/ui";
import { itemsAfter, useFileSlots, type FileSlots, type SlotItem } from "./commenting";
import { MeasuredSlot, SlotSpacer, SlotView } from "./comments";
import { highlightFile, type Span } from "./highlight";
import { fileNotices, splitPairs, type FileDiff, type Hunk, type PatchLine } from "./patch";

/*
 * The changes view: a header per file
 * (chevron, icon, path, +N −N, open), then its hunks line by line, unified
 * or split, on emerald / red washes with an accent bar.
 */

const LINE_HEIGHT = 20;
const HEADER_HEIGHT = 32;
const HUNK_HEIGHT = 26;

/** Soft emerald and red (Tailwind's emerald-400, red-400). */
const ROW: Record<PatchLine["kind"], { row: string; accent: string; marker: string; no: string }> =
    {
        add: {
            row: "bg-[#34d399]/[0.07]",
            accent: "bg-[#34d399]/55",
            marker: "text-[#34d399]",
            no: "text-[#34d399]/90"
        },
        del: {
            row: "bg-[#f87171]/[0.07]",
            accent: "bg-[#f87171]/55",
            marker: "text-[#f87171]",
            no: "text-[#f87171]/90"
        },
        context: { row: "", accent: "", marker: "", no: "text-dark-250" },
        meta: { row: "", accent: "", marker: "", no: "text-dark-250" }
    };

/** One line-number column, fitted to the file's largest number; none for an unnumbered file. */
const gutterWidth = (file: FileDiff) =>
    file.maxLine ? Math.max(String(file.maxLine).length * 7 + 14, 36) : 0;

type FileSectionProps = {
    file: FileDiff;
    first: boolean;
    folded: boolean;
    split: boolean;
    wrap: boolean;
    onToggle: (path: string, folded: boolean) => void;
    /** Missing for a file that's gone (deleted). */
    onOpen?: (path: string) => void;
    /** Undoes the file's changes (the latest turn's diff only). */
    onRevert?: (file: FileDiff) => void;
};

/** A file's header and, unfolded, its body; off-screen ones skip layout. */
export const FileSection = memo(function FileSection({
    file,
    first,
    folded,
    split,
    wrap,
    onToggle,
    onOpen,
    onRevert
}: FileSectionProps) {
    const notices = fileNotices(file);
    const estimate =
        HEADER_HEIGHT +
        (folded ? 0 : notices.length * 24 + file.hunks.length * HUNK_HEIGHT + file.lineCount * LINE_HEIGHT);
    return (
        <section
            style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${estimate}px` }}
            className={cn(!first && "border-t border-white/[0.04]")}
        >
            <FileHeader
                file={file}
                folded={folded}
                onToggle={onToggle}
                onOpen={onOpen}
                onRevert={onRevert}
            />
            {!folded && (
                <div className="pb-2">
                    {notices.map((notice) => (
                        <div
                            key={notice}
                            className="flex h-6 items-center px-4 text-[11px] text-dark-250"
                        >
                            {notice}
                        </div>
                    ))}
                    {file.hunks.length > 0 && <FileBody file={file} split={split} wrap={wrap} />}
                </div>
            )}
        </section>
    );
});

function FileHeader({
    file,
    folded,
    onToggle,
    onOpen,
    onRevert
}: {
    file: FileDiff;
    folded: boolean;
    onToggle: (path: string, folded: boolean) => void;
    onOpen?: (path: string) => void;
    onRevert?: (file: FileDiff) => void;
}) {
    const slash = file.path.lastIndexOf("/");
    const dir = file.path.slice(0, slash + 1);
    const name = file.path.slice(slash + 1);
    return (
        <div
            role="button"
            tabIndex={0}
            aria-expanded={!folded}
            onClick={() => onToggle(file.path, folded)}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onToggle(file.path, folded);
                }
            }}
            style={{ height: HEADER_HEIGHT }}
            // Opaque, so it can stick over the lines scrolling under it.
            className={cn(
                "group/header sticky top-0 z-10 flex cursor-pointer items-center gap-2 bg-dark-850 px-3 outline-none select-none",
                "shadow-[inset_0_0_0_999px_rgba(255,255,255,0.025)] hover:shadow-[inset_0_0_0_999px_rgba(255,255,255,0.05)]",
                "focus-visible:shadow-[inset_0_0_0_999px_rgba(255,255,255,0.05)]",
                !folded && "border-b border-white/[0.04]"
            )}
        >
            <CaretRightIcon
                className={cn(
                    "size-3 shrink-0 text-dark-250 transition-transform duration-200",
                    !folded && "rotate-90"
                )}
                weight="bold"
            />
            <FileIcon name={name} className="size-3.5" />
            <span className="flex min-w-0 flex-1 text-xs">
                <span className="truncate text-dark-250">{dir}</span>
                <span className="shrink-0 text-dark-100">{name}</span>
            </span>
            {file.binary && <span className="shrink-0 text-[10px] text-dark-250">BIN</span>}
            <LineCounts
                additions={file.additions > 0 || !file.binary ? file.additions : undefined}
                deletions={file.deletions > 0 || !file.binary ? file.deletions : undefined}
                className="shrink-0 text-[11px]"
            />
            {onRevert && (
                <HeaderButton label="Undo this file's changes" onClick={() => onRevert(file)}>
                    <ArrowCounterClockwiseIcon className="size-3.5" />
                </HeaderButton>
            )}
            {onOpen && (
                <HeaderButton label="Open file" onClick={() => onOpen(file.path)}>
                    <ArrowSquareOutIcon className="size-3.5" />
                </HeaderButton>
            )}
        </div>
    );
}

/** A button in a file's header, which doesn't fold or unfold the file. */
function HeaderButton({
    label,
    onClick,
    children
}: {
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <IconButton
            label={label}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            onKeyDown={(event) => event.stopPropagation()}
        >
            {children}
        </IconButton>
    );
}

/** "+N −N" in the diff's green and red; a count left out isn't shown. */
export function LineCounts({
    additions,
    deletions,
    className
}: {
    additions?: number;
    deletions?: number;
    className?: string;
}) {
    return (
        <>
            {additions !== undefined && (
                <span className={cn("tabular-nums text-[#34d399]", className)}>+{additions}</span>
            )}
            {deletions !== undefined && (
                <span className={cn("tabular-nums text-[#f87171]", className)}>−{deletions}</span>
            )}
        </>
    );
}

/** The file's syntax colours, once worked out (they don't change its layout). */
function useHighlights(file: FileDiff) {
    const [spans, setSpans] = useState<{ file: FileDiff; map: Map<PatchLine, Span[]> | null }>();
    useEffect(() => {
        let live = true;
        void highlightFile(file).then((map) => live && setSpans({ file, map }));
        return () => {
            live = false;
        };
    }, [file]);
    return spans?.file === file ? spans.map : null;
}

/** A file's hunks, unified or split; also the transcript's file-change diffs. */
export function FileBody({ file, split, wrap }: { file: FileDiff; split: boolean; wrap: boolean }) {
    const spans = useHighlights(file);
    const gutter = gutterWidth(file);
    const slots = useFileSlots(file);
    const row = rowProps(file, slots);
    if (!split) {
        const oneSide = file.hunks.every((hunk) => hunk.lines.every((line) => line.oldNo === undefined));
        return (
            <Scroller wrap={wrap} container={!!slots}>
                {file.hunks.map((hunk, h) => (
                    <div key={h}>
                        {hunk.header && <HunkHeader header={hunk.header} />}
                        {hunk.lines.map((line, i) => (
                            <Fragment key={i}>
                                <UnifiedRow
                                    line={line}
                                    spans={spans?.get(line)}
                                    gutter={gutter}
                                    wrap={wrap}
                                    oneSide={oneSide}
                                    {...row(line)}
                                />
                                {itemsAfter(slots, [line]).map((item) => (
                                    <SlotView key={item.key} file={file} item={item} sticky={!wrap} />
                                ))}
                            </Fragment>
                        ))}
                    </div>
                ))}
            </Scroller>
        );
    }
    // Wrapped rows differ in height, so each one holds both sides; unwrapped,
    // each side is a column of its own that scrolls sideways on its own.
    if (wrap) {
        return (
            <div>
                {file.hunks.map((hunk, h) => (
                    <div key={h}>
                        <HunkHeader header={hunk.header} />
                        {splitPairs(hunk.lines).map(([left, right], i) => {
                            const l = pick(hunk, left);
                            const r = pick(hunk, right);
                            return (
                                <Fragment key={i}>
                                    <div className="grid grid-cols-2">
                                        <SplitCell
                                            line={l}
                                            side="old"
                                            spans={spans}
                                            gutter={gutter}
                                            wrap
                                            {...(l && row(l))}
                                        />
                                        <SplitCell
                                            line={r}
                                            side="new"
                                            spans={spans}
                                            gutter={gutter}
                                            wrap
                                            divider
                                            {...(r && row(r))}
                                        />
                                    </div>
                                    {itemsAfter(slots, [l, r]).map((item) => (
                                        <div key={item.key} className="grid grid-cols-2">
                                            <div>
                                                {item.side === "old" && (
                                                    <SlotView file={file} item={item} sticky={false} />
                                                )}
                                            </div>
                                            <div className="border-l border-dark-600">
                                                {item.side === "new" && (
                                                    <SlotView file={file} item={item} sticky={false} />
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </Fragment>
                            );
                        })}
                    </div>
                ))}
            </div>
        );
    }
    const pairs = file.hunks.map((hunk) => splitPairs(hunk.lines));
    return (
        <div className="grid grid-cols-2">
            {(["old", "new"] as const).map((side) => (
                <Scroller
                    key={side}
                    wrap={false}
                    container={!!slots}
                    className={side === "new" ? "border-l border-dark-600" : undefined}
                >
                    {file.hunks.map((hunk, h) => (
                        <div key={h}>
                            <HunkHeader header={side === "old" ? hunk.header : ""} />
                            {pairs[h]!.map((pair, i) => {
                                const line = pick(hunk, side === "old" ? pair[0] : pair[1]);
                                const items = itemsAfter(slots, [
                                    pick(hunk, pair[0]),
                                    pick(hunk, pair[1])
                                ]);
                                return (
                                    <Fragment key={i}>
                                        <SplitCell
                                            line={line}
                                            side={side}
                                            spans={spans}
                                            gutter={gutter}
                                            wrap={false}
                                            {...(line && row(line))}
                                        />
                                        {items.map((item) => (
                                            <SplitSlot
                                                key={item.key}
                                                file={file}
                                                item={item}
                                                side={side}
                                            />
                                        ))}
                                    </Fragment>
                                );
                            })}
                        </div>
                    ))}
                </Scroller>
            ))}
        </div>
    );
}

const pick = (hunk: Hunk, index: number | undefined) =>
    index === undefined ? undefined : hunk.lines[index];

/** A row's commenting props: its gutter opens the comment box, the box's lines tinted. */
type CommentProps = { onComment?: (line: PatchLine, extend: boolean) => void; picked?: boolean };

function rowProps(file: FileDiff, slots: FileSlots | null) {
    return (line: PatchLine): CommentProps => {
        const ref = slots && lineRef(line);
        if (!slots || !ref) return {};
        return {
            onComment: (l, extend) => slots.begin(file, l, extend),
            picked: slots.picked?.has(refKey(ref)) ?? false
        };
    };
}

/** An item in its own column; a spacer as tall in the other one, keeping rows paired. */
function SplitSlot({ file, item, side }: { file: FileDiff; item: SlotItem; side: "old" | "new" }) {
    const id = `${file.path}|${item.key}`;
    if (item.side !== side) return <SlotSpacer id={id} />;
    return (
        <MeasuredSlot id={id}>
            <SlotView file={file} item={item} sticky />
        </MeasuredSlot>
    );
}

/** Scrolls sideways as one when lines don't wrap. */
function Scroller({
    wrap,
    container,
    className,
    children
}: {
    wrap: boolean;
    /** Sizes comments to the visible width (`cqw`). */
    container?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                "min-w-0",
                container && "@container",
                !wrap && "overflow-x-auto overscroll-x-contain",
                className
            )}
        >
            {/* As wide as its longest line, or the panel if that's wider. */}
            <div className={cn(!wrap && "w-max min-w-full")}>{children}</div>
        </div>
    );
}

function HunkHeader({ header }: { header: string }) {
    return (
        <div
            style={{ height: HUNK_HEIGHT }}
            className="flex items-center bg-[#6fb3f2]/[0.06] px-4 font-mono text-[11px] whitespace-pre text-dark-250"
        >
            {header}
        </div>
    );
}

const codeClassName = (wrap: boolean) =>
    cn(
        "min-w-0 flex-1 pr-6 font-mono text-xs text-[#e6edf3]/90",
        wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"
    );
const TAB: CSSProperties = { tabSize: 4, lineHeight: `${LINE_HEIGHT}px` };

function UnifiedRow({
    line,
    ...props
}: {
    line: PatchLine;
    spans: Span[] | undefined;
    gutter: number;
    wrap: boolean;
    /** The file has no old side (a new file, a file as read): one number column. */
    oneSide?: boolean;
} & CommentProps) {
    if (line.kind === "meta") return <MetaRow text={line.text} />;
    const { oneSide, ...rest } = props;
    return <LineRow line={line} numbers={oneSide ? [line.newNo] : [line.oldNo, line.newNo]} {...rest} />;
}

/** A line (not a meta one): its gutter (numbers, marker; the comment button) and its code. */
function LineRow({
    line,
    numbers,
    narrow,
    spans,
    gutter,
    wrap,
    className,
    onComment,
    picked
}: {
    line: PatchLine;
    /** The line numbers to show: both sides' (unified) or one side's (split). */
    numbers: (number | undefined)[];
    /** A split column's narrower marker. */
    narrow?: boolean;
    spans: Span[] | undefined;
    gutter: number;
    wrap: boolean;
    className?: string;
} & CommentProps) {
    const tone = ROW[line.kind];
    return (
        <div
            className={cn("group/row relative flex", tone.row, className)}
            style={{ minHeight: LINE_HEIGHT }}
        >
            {picked && <Picked />}
            {/* The numbers stay put while the code scrolls sideways. */}
            <div
                {...gutterProps(line, onComment)}
                className={cn(
                    "sticky left-0 z-[2] flex shrink-0 bg-dark-850",
                    onComment && "cursor-pointer"
                )}
            >
                <span className={cn("absolute inset-0", tone.row)} />
                {picked && <Picked />}
                {tone.accent && <span className={cn("absolute inset-y-0 left-0 w-[3px]", tone.accent)} />}
                {gutter > 0 &&
                    numbers.map((no, i) => (
                        <LineNo key={i} no={no} width={gutter} className={tone.no} />
                    ))}
                <Marker kind={line.kind} narrow={narrow} commentable={!!onComment} />
            </div>
            <Code text={line.text} spans={spans} wrap={wrap} />
        </div>
    );
}

function SplitCell({
    line,
    side,
    spans,
    gutter,
    wrap,
    divider,
    onComment,
    picked
}: {
    line: PatchLine | undefined;
    side: "old" | "new";
    spans: Map<PatchLine, Span[]> | null;
    gutter: number;
    wrap: boolean;
    divider?: boolean;
} & CommentProps) {
    const border = divider && "border-l border-dark-600";
    if (!line) {
        // Nothing on this side: a quiet filler the height of a line.
        return <div className={cn("bg-white/[0.015]", border)} style={{ minHeight: LINE_HEIGHT }} />;
    }
    if (line.kind === "meta") {
        return (
            <div className={cn(border)}>
                <MetaRow text={line.text} />
            </div>
        );
    }
    return (
        <LineRow
            line={line}
            numbers={[side === "old" ? line.oldNo : line.newNo]}
            narrow
            spans={spans?.get(line)}
            gutter={gutter}
            wrap={wrap}
            className={cn("min-w-0", border)}
            onComment={onComment}
            picked={picked}
        />
    );
}

function LineNo({ no, width, className }: { no?: number; width: number; className: string }) {
    return (
        <span
            style={{ width, lineHeight: `${LINE_HEIGHT}px` }}
            className={cn("relative shrink-0 pr-2 text-right font-mono text-[11px] select-none", className)}
        >
            {no}
        </span>
    );
}

function Marker({
    kind,
    narrow,
    commentable
}: {
    kind: PatchLine["kind"];
    narrow?: boolean;
    commentable?: boolean;
}) {
    return (
        <span
            style={{ lineHeight: `${LINE_HEIGHT}px` }}
            className={cn(
                "relative shrink-0 text-center font-mono text-xs select-none",
                narrow ? "w-[18px]" : "w-7",
                ROW[kind].marker
            )}
        >
            <span className={cn(commentable && "group-hover/row:invisible")}>
                {kind === "add" ? "+" : kind === "del" ? "−" : ""}
            </span>
            {commentable && (
                <span
                    aria-hidden="true"
                    className="absolute top-1/2 left-1/2 hidden size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded bg-info text-dark-900 group-hover/row:flex"
                >
                    <PlusIcon className="size-3" weight="bold" />
                </span>
            )}
        </span>
    );
}

/** The comment box's lines, tinted. */
function Picked() {
    return <span className="pointer-events-none absolute inset-0 z-[1] bg-info/[0.14]" />;
}

/** The gutter as the line's comment button: click comments, Shift+click stretches the range. */
function gutterProps(line: PatchLine, onComment: CommentProps["onComment"]) {
    if (!onComment) return {};
    return {
        role: "button" as const,
        "aria-label": "Comment on this line",
        onMouseDown: (event: React.MouseEvent) => {
            // Shift+click would select text from the last click.
            if (event.shiftKey) event.preventDefault();
        },
        onClick: (event: React.MouseEvent) => onComment(line, event.shiftKey)
    };
}

function MetaRow({ text }: { text: string }) {
    return (
        <div
            style={{ height: LINE_HEIGHT }}
            className="flex items-center pl-4 font-mono text-[11px] whitespace-pre text-dark-250 italic"
        >
            {text}
        </div>
    );
}

/** A line's text, in its syntax colours once they're known. */
function Code({ text, spans, wrap }: { text: string; spans: Span[] | undefined; wrap: boolean }) {
    let content: ReactNode = text;
    if (spans?.length) {
        const parts: ReactNode[] = [];
        let at = 0;
        spans.forEach((span, i) => {
            if (span.from > at) parts.push(text.slice(at, span.from));
            parts.push(
                <span key={i} style={span.style}>
                    {text.slice(span.from, span.to)}
                </span>
            );
            at = span.to;
        });
        if (at < text.length) parts.push(text.slice(at));
        content = parts;
    }
    return (
        <span style={TAB} className={codeClassName(wrap)}>
            {content}
        </span>
    );
}
