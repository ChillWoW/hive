import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowSquareOutIcon, CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { FileIcon, iconButtonClassName, Tooltip } from "@/ui";
import { highlightFile, type Span } from "./highlight";
import { fileNotices, splitPairs, type FileDiff, type Hunk, type PatchLine } from "./patch";

/*
 * Zeron's Changes pane (`crates/ui/src/changes.rs`): a header per file
 * (chevron, icon, path, +N −N, open), then its hunks line by line, unified
 * or split, on emerald / red washes with an accent bar.
 */

const LINE_HEIGHT = 20;
const HEADER_HEIGHT = 32;
const HUNK_HEIGHT = 26;

/** Zeron's soft emerald and red (Tailwind's emerald-400, red-400). */
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

/** One line-number column, fitted to the file's largest number. */
const gutterWidth = (file: FileDiff) => Math.max(String(file.maxLine || 1).length * 7 + 14, 36);

export type FileSectionProps = {
    file: FileDiff;
    first: boolean;
    folded: boolean;
    split: boolean;
    wrap: boolean;
    onToggle: (path: string, folded: boolean) => void;
    /** Missing for a file that's gone (deleted). */
    onOpen?: (path: string) => void;
};

/** A file's header and, unfolded, its body; off-screen ones skip layout. */
export const FileSection = memo(function FileSection({
    file,
    first,
    folded,
    split,
    wrap,
    onToggle,
    onOpen
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
            <FileHeader file={file} folded={folded} onToggle={onToggle} onOpen={onOpen} />
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
    onOpen
}: {
    file: FileDiff;
    folded: boolean;
    onToggle: (path: string, folded: boolean) => void;
    onOpen?: (path: string) => void;
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
            {(file.additions > 0 || !file.binary) && (
                <span className="shrink-0 text-[11px] tabular-nums text-[#34d399]">
                    +{file.additions}
                </span>
            )}
            {(file.deletions > 0 || !file.binary) && (
                <span className="shrink-0 text-[11px] tabular-nums text-[#f87171]">
                    −{file.deletions}
                </span>
            )}
            {onOpen && (
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <button
                                type="button"
                                aria-label="Open file"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onOpen(file.path);
                                }}
                                onKeyDown={(event) => event.stopPropagation()}
                                className={iconButtonClassName}
                            >
                                <ArrowSquareOutIcon className="size-3.5" />
                            </button>
                        }
                    />
                    <Tooltip.Content side="bottom">Open file</Tooltip.Content>
                </Tooltip>
            )}
        </div>
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

function FileBody({ file, split, wrap }: { file: FileDiff; split: boolean; wrap: boolean }) {
    const spans = useHighlights(file);
    const gutter = gutterWidth(file);
    if (!split) {
        return (
            <Scroller wrap={wrap}>
                {file.hunks.map((hunk, h) => (
                    <div key={h}>
                        <HunkHeader header={hunk.header} />
                        {hunk.lines.map((line, i) => (
                            <UnifiedRow
                                key={i}
                                line={line}
                                spans={spans?.get(line)}
                                gutter={gutter}
                                wrap={wrap}
                            />
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
                        {splitPairs(hunk.lines).map(([left, right], i) => (
                            <div key={i} className="grid grid-cols-2">
                                <SplitCell
                                    line={pick(hunk, left)}
                                    side="old"
                                    spans={spans}
                                    gutter={gutter}
                                    wrap
                                />
                                <SplitCell
                                    line={pick(hunk, right)}
                                    side="new"
                                    spans={spans}
                                    gutter={gutter}
                                    wrap
                                    divider
                                />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        );
    }
    const pairs = file.hunks.map((hunk) => splitPairs(hunk.lines));
    return (
        <div className="grid grid-cols-2">
            {(["old", "new"] as const).map((side) => (
                <Scroller key={side} wrap={false} className={side === "new" ? "border-l border-dark-600" : undefined}>
                    {file.hunks.map((hunk, h) => (
                        <div key={h}>
                            <HunkHeader header={side === "old" ? hunk.header : ""} />
                            {pairs[h]!.map((pair, i) => (
                                <SplitCell
                                    key={i}
                                    line={pick(hunk, side === "old" ? pair[0] : pair[1])}
                                    side={side}
                                    spans={spans}
                                    gutter={gutter}
                                    wrap={false}
                                />
                            ))}
                        </div>
                    ))}
                </Scroller>
            ))}
        </div>
    );
}

const pick = (hunk: Hunk, index: number | undefined) =>
    index === undefined ? undefined : hunk.lines[index];

/** Scrolls sideways as one when lines don't wrap. */
function Scroller({
    wrap,
    className,
    children
}: {
    wrap: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={cn("min-w-0", !wrap && "overflow-x-auto overscroll-x-contain", className)}>
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
    spans,
    gutter,
    wrap
}: {
    line: PatchLine;
    spans: Span[] | undefined;
    gutter: number;
    wrap: boolean;
}) {
    const tone = ROW[line.kind];
    if (line.kind === "meta") return <MetaRow text={line.text} />;
    return (
        <div className={cn("relative flex", tone.row)} style={{ minHeight: LINE_HEIGHT }}>
            {/* The numbers stay put while the code scrolls sideways. */}
            <div className="sticky left-0 z-[1] flex shrink-0 bg-dark-850">
                <span className={cn("absolute inset-0", tone.row)} />
                {tone.accent && <span className={cn("absolute inset-y-0 left-0 w-[3px]", tone.accent)} />}
                <LineNo no={line.oldNo} width={gutter} className={tone.no} />
                <LineNo no={line.newNo} width={gutter} className={tone.no} />
                <Marker kind={line.kind} />
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
    divider
}: {
    line: PatchLine | undefined;
    side: "old" | "new";
    spans: Map<PatchLine, Span[]> | null;
    gutter: number;
    wrap: boolean;
    divider?: boolean;
}) {
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
    const tone = ROW[line.kind];
    return (
        <div className={cn("relative flex min-w-0", tone.row, border)} style={{ minHeight: LINE_HEIGHT }}>
            <div className="sticky left-0 z-[1] flex shrink-0 bg-dark-850">
                <span className={cn("absolute inset-0", tone.row)} />
                {tone.accent && <span className={cn("absolute inset-y-0 left-0 w-[3px]", tone.accent)} />}
                <LineNo
                    no={side === "old" ? line.oldNo : line.newNo}
                    width={gutter}
                    className={tone.no}
                />
                <Marker kind={line.kind} narrow />
            </div>
            <Code text={line.text} spans={spans?.get(line)} wrap={wrap} />
        </div>
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

function Marker({ kind, narrow }: { kind: PatchLine["kind"]; narrow?: boolean }) {
    return (
        <span
            style={{ lineHeight: `${LINE_HEIGHT}px` }}
            className={cn(
                "relative shrink-0 text-center font-mono text-xs select-none",
                narrow ? "w-[18px]" : "w-7",
                ROW[kind].marker
            )}
        >
            {kind === "add" ? "+" : kind === "del" ? "−" : ""}
        </span>
    );
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
