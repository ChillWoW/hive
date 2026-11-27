import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    ArrowsLeftRightIcon,
    CaretRightIcon,
    ChatsIcon,
    ClockCounterClockwiseIcon,
    CheckIcon,
    LightningIcon,
    MagnifyingGlassIcon,
    StarIcon
} from "@phosphor-icons/react";
import type { Catalog, ChatConfig, HandoffMode, HarnessId, Model, ReasoningLevel } from "@/proto";
import { cn } from "@/lib/cn";
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@/ui";
import {
    footerButtonClassName,
    pickerTriggerClassName,
    popupClassName,
    searchInputClassName
} from "@/ui/chip";
import {
    fitConfig,
    HARNESS_LABELS,
    harnessOf,
    HARNESSES,
    hasFastMode,
    isFastMode,
    REASONING_LABELS,
    refreshCatalog,
    resolveModel,
    resolveReasoning,
    useCatalogs,
    withFastMode
} from "./catalog";
import { HarnessMark } from "./HarnessMark";
import { useFavoriteModels } from "./favorites";

/** A row is 32px plus the list's 2px gap; tabs and scrolling count in rows. */
const ROW_PITCH = 34;
/** Rows shown before the list scrolls. */
const VISIBLE_ROWS = 7;

type Row = { model: Model; harness: HarnessId; favorite: boolean };
/** A run of rows the tab strip can jump to: the starred ones, then each harness's. */
type Group = { id: "starred" | HarnessId; label: string; start: number };

const isRow = (row: Row, harness: HarnessId, model: Model) => row.harness === harness && row.model.id === model.id;

function matches(row: Row, query: string) {
    return `${row.model.label} ${row.model.id}`.toLowerCase().includes(query);
}

/**
 * Model and reasoning effort in one picker. The chip names the model with
 * its harness's mark and the effort after it (models without levels have
 * none).
 *
 * The card lists every installed harness's models under tabs (starred
 * models first, then Claude's, Codex's and Antigravity's); picking another harness's
 * model moves the chat there, in a new session. A search sits
 * above and a Reasoning row below, which opens the picked model's levels in
 * a card beside it; models with fast mode (Opus) get a Fast mode row above
 * it that opens On / Off the same way; while it's on, a bolt replaces the
 * chip's mark. A model's effort defaults to High (else Medium, else its
 * first level). Picking a model keeps the card open so its effort can be
 * set next.
 *
 * Given `handoff` (a chat with a conversation to carry on), picking another
 * model asks where to continue first: in this chat or a new one, either way
 * in a new session with a summary of it, since another model would get the
 * whole history again uncached. Another model of the same harness can also
 * keep the session.
 *
 * Elsewhere (Settings › Chats), `placement` and `triggerClassName` fit it
 * to a form; `modelOnly` drops effort and fast mode, for runs that take
 * neither (text generation); `harnesses` limits what it lists.
 */
export function ModelPicker({
    config,
    onChange,
    placement = "top",
    triggerClassName,
    modelOnly = false,
    harnesses = HARNESSES,
    handoff
}: {
    config: ChatConfig;
    onChange: (config: ChatConfig) => void;
    placement?: "top" | "bottom";
    triggerClassName?: string;
    modelOnly?: boolean;
    harnesses?: HarnessId[];
    handoff?: PickerHandoff;
}) {
    const catalogs = useCatalogs();
    const harness = harnessOf(config);
    const catalog = catalogs[harness] ?? null;
    const model = resolveModel(catalog, config);
    // Installed ones, and the config's own even when it isn't.
    const listed = harnesses.flatMap((id) => {
        const c = catalogs[id];
        return c && (c.installed || id === harness) ? [{ harness: id, catalog: c }] : [];
    });
    const reasoning = modelOnly ? undefined : resolveReasoning(model, config);
    const fast = !modelOnly && isFastMode(model, config);
    const showFast = !modelOnly && hasFastMode(model);
    const showEffort = !modelOnly && !!model?.reasoningLevels.length;
    const [open, setOpen] = useState(false);
    const [side, setSide] = useState<Side | null>(null);
    // Another model, waiting on where to continue.
    const [pending, setPending] = useState<{ config: ChatConfig; model: Model } | null>(null);
    const toggleSide = (next: Side) => {
        setPending(null);
        setSide((s) => (s === next ? null : next));
    };

    if (!catalog || !model) {
        return (
            <span className="h-8 truncate px-2.5 text-sm leading-8 text-muted/75 select-none">
                {catalog ? "No models" : "Loading…"}
            </span>
        );
    }

    return (
        <Popover.Root
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) void refreshCatalog();
                else {
                    setSide(null);
                    setPending(null);
                }
            }}
        >
            <Popover.Trigger
                aria-label={`Model: ${model.label}`}
                className={cn(pickerTriggerClassName, "gap-1.5", triggerClassName)}
            >
                {fast ? (
                    <LightningIcon weight="fill" aria-label="Fast mode" className="size-3.5 shrink-0" />
                ) : (
                    <HarnessMark harness={harness} className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{model.label}</span>
                {reasoning && (
                    // Yields first under pressure, so the model name truncates last.
                    <span className="min-w-0 shrink-[1000] truncate text-muted/75">
                        {REASONING_LABELS[reasoning]}
                    </span>
                )}
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner
                    side={placement}
                    align="end"
                    sideOffset={10}
                    // The extra room on top keeps it off the top bar, the
                    // window's drag handle.
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                >
                    <Popover.Popup
                        aria-label="Choose a model"
                        initialFocus={() => document.getElementById(SEARCH_ID)}
                        className={cn(popupClassName, "w-72 min-w-0 rounded-md p-1")}
                    >
                        <ModelCard
                            listed={listed}
                            harness={harness}
                            model={model}
                            reasoning={reasoning}
                            fast={fast}
                            showFast={showFast}
                            showEffort={showEffort}
                            onPick={(row) => {
                                const next = fitConfig(catalogs[row.harness] ?? catalog, {
                                    ...config,
                                    harness: row.harness,
                                    model: row.model.id
                                });
                                if (handoff) {
                                    setSide(null);
                                    setPending({ config: next, model: row.model });
                                    return;
                                }
                                setPending(null);
                                onChange(next);
                            }}
                            side={side}
                            onToggleSide={toggleSide}
                        />
                    </Popover.Popup>
                    {pending && handoff && (
                        <HandoffCard
                            harness={harnessOf(pending.config)}
                            model={pending.model}
                            canKeep={harnessOf(pending.config) === harness}
                            blocked={handoff.blocked}
                            onSelect={(mode) => {
                                if (mode === "keep") onChange(pending.config);
                                else handoff.onHandoff(pending.config, mode);
                                setPending(null);
                                setOpen(false);
                            }}
                        />
                    )}
                    {/* Siblings of the popup, which clips its overflow; the
                        positioner is what they're placed against. */}
                    {side === "fast" && showFast && (
                        <SideCard
                            label="Fast mode"
                            options={FAST_CHOICES}
                            value={fast ? "on" : "off"}
                            // Level with the Fast mode row, one above Reasoning.
                            lift={showEffort}
                            onSelect={(choice) => {
                                onChange(withFastMode(config, choice === "on"));
                                setSide(null);
                            }}
                        />
                    )}
                    {side === "effort" && showEffort && (
                        <SideCard
                            label="Reasoning effort"
                            // Highest first, so the list reads the way the effort grows.
                            options={[...model.reasoningLevels]
                                .reverse()
                                .map((level) => ({ id: level, label: REASONING_LABELS[level] }))}
                            value={reasoning}
                            onSelect={(reasoning) => {
                                onChange({ ...config, reasoning });
                                setSide(null);
                            }}
                        />
                    )}
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
}

const SEARCH_ID = "model-picker-search";

/** A chat the picker can hand to another model's agent. */
export type PickerHandoff = {
    /** Why it can't be now (a turn running), else null. */
    blocked: string | null;
    onHandoff: (config: ChatConfig, mode: HandoffMode) => void;
};

/** A handoff, or (same harness) resuming the session on the new model. */
type HandoffChoice = HandoffMode | "keep";

const HANDOFF_CHOICES: { mode: HandoffChoice; label: string; hint: string; icon: typeof ChatsIcon }[] = [
    { mode: "sameChat", label: "In this chat", hint: "New session, with a summary", icon: ArrowsLeftRightIcon },
    { mode: "newChat", label: "In a new chat", hint: "This one stays as it is", icon: ChatsIcon },
    { mode: "keep", label: "Keep the session", hint: "Full history, sent again uncached", icon: ClockCounterClockwiseIcon }
];

/**
 * Where to continue on another model, beside the card's top: in this chat
 * or a new one, its agent given a summary of the conversation; with
 * `canKeep` (the same harness), also by resuming the session as it is.
 */
function HandoffCard({
    harness,
    model,
    canKeep,
    blocked,
    onSelect
}: {
    harness: HarnessId;
    model: Model;
    canKeep: boolean;
    blocked: string | null;
    onSelect: (mode: HandoffChoice) => void;
}) {
    const choices = HANDOFF_CHOICES.filter((c) => canKeep || c.mode !== "keep");
    return (
        <div
            role="group"
            aria-label={`Continue in ${HARNESS_LABELS[harness]}`}
            className={cn(
                "pointer-events-auto absolute top-0 right-full mr-2 w-56",
                "rounded-md border border-border bg-surface p-1 shadow-lg shadow-shadow/40",
                "transition-opacity duration-150 ease-out starting:opacity-0"
            )}
        >
            <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-xs text-muted/85">
                <HarnessMark harness={harness} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">Continue with {model.label}</span>
            </div>
            {choices.map(({ mode, label, hint, icon: Icon }, i) => (
                <button
                    key={mode}
                    type="button"
                    // Resuming waits for a running turn on its own.
                    disabled={!!blocked && mode !== "keep"}
                    // Keyboard picks land here next.
                    autoFocus={i === 0}
                    onClick={() => onSelect(mode)}
                    className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none select-none",
                        "text-text hover:bg-hover focus-visible:bg-hover disabled:pointer-events-none disabled:opacity-50"
                    )}
                >
                    <Icon className="size-3.5 shrink-0 text-muted" />
                    <span className="flex min-w-0 flex-col">
                        <span className="text-xs">{label}</span>
                        <span className="truncate text-[11px] text-muted/75">{hint}</span>
                    </span>
                </button>
            ))}
            {blocked && <p className="px-2.5 pt-1 pb-1.5 text-[11px] text-warning">{blocked}</p>}
        </div>
    );
}

/** The footer row whose card is open beside the picker. */
type Side = "fast" | "effort";

const FAST_CHOICES = [
    { id: "on", label: "On" },
    { id: "off", label: "Off" }
] as const;

function ModelCard({
    listed,
    harness,
    model,
    reasoning,
    fast,
    showFast,
    showEffort,
    onPick,
    side,
    onToggleSide
}: {
    listed: { harness: HarnessId; catalog: Catalog }[];
    harness: HarnessId;
    model: Model;
    reasoning: ReasoningLevel | undefined;
    fast: boolean;
    showFast: boolean;
    showEffort: boolean;
    onPick: (row: Row) => void;
    side: Side | null;
    onToggleSide: (side: Side) => void;
}) {
    const [favorites, toggleFavorite] = useFavoriteModels();
    const [query, setQuery] = useState("");
    const listRef = useRef<HTMLDivElement>(null);

    // Starred models first, then each harness's rest, in catalog order.
    const { rows, groups } = useMemo(() => {
        const starred: Row[] = [];
        const rest: Row[][] = listed.map(() => []);
        listed.forEach(({ harness, catalog }, i) => {
            for (const m of catalog.models) {
                const row = { model: m, harness, favorite: favorites.includes(m.id) };
                (row.favorite ? starred : rest[i]).push(row);
            }
        });
        const groups: Group[] = [];
        if (starred.length) groups.push({ id: "starred", label: "Starred", start: 0 });
        let start = starred.length;
        listed.forEach(({ harness }, i) => {
            if (rest[i].length) groups.push({ id: harness, label: HARNESS_LABELS[harness], start });
            start += rest[i].length;
        });
        return { rows: [...starred, ...rest.flat()], groups };
    }, [listed, favorites]);

    const q = query.trim().toLowerCase();
    const shown = q ? rows.filter((row) => matches(row, q)) : rows;
    const selectedIndex = shown.findIndex((row) => isRow(row, harness, model));
    const [active, setActive] = useState(Math.max(0, selectedIndex));
    /** Keyboard moves scroll the active row into view; the pointer doesn't. */
    const keyboardRef = useRef(false);

    // Opens on the current model: at the top of the list when it's near
    // there, else centred.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (!list || selectedIndex < VISIBLE_ROWS - 2) return;
        list.scrollTop = (selectedIndex - Math.floor(VISIBLE_ROWS / 2)) * ROW_PITCH;
        // Once, on open.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useLayoutEffect(() => {
        if (!keyboardRef.current) return;
        listRef.current
            ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const pick = (row: Row) => {
        if (!isRow(row, harness, model)) onPick(row);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        const last = shown.length - 1;
        const move = (next: number) => {
            event.preventDefault();
            keyboardRef.current = true;
            setActive(Math.max(0, Math.min(last, next)));
        };
        switch (event.key) {
            case "ArrowDown":
                return move(active + 1);
            case "ArrowUp":
                return move(active - 1);
            case "PageDown":
                return move(active + VISIBLE_ROWS);
            case "PageUp":
                return move(active - VISIBLE_ROWS);
            case "Enter": {
                event.preventDefault();
                const row = shown[active];
                if (row) pick(row);
                return;
            }
        }
    };

    // The lit tab is the highlighted row's group: a tab click highlights its
    // first row, and hovering or arrowing through rows moves it along.
    const viewed = [...groups].reverse().find((g) => g.start <= active)?.id;

    return (
        <div className="flex flex-col">
            {/* Searching flattens the list, so the tabs step aside; one group
                has nothing to jump between. */}
            {!q && groups.length > 1 && (
                <div className="hide-scrollbar flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto">
                    {groups.map((group) => (
                        <Tooltip key={group.id}>
                            <Tooltip.Trigger
                                render={
                                    <button
                                        type="button"
                                        aria-label={`Jump to ${group.label}`}
                                        onClick={() => {
                                            listRef.current?.scrollTo({ top: group.start * ROW_PITCH });
                                            keyboardRef.current = false;
                                            setActive(group.start);
                                        }}
                                        className={cn(
                                            "inline-flex size-8 shrink-0 items-center justify-center rounded-md outline-none",
                                            "transition-[background-color,opacity] duration-150",
                                            viewed === group.id
                                                ? "bg-hover"
                                                : "opacity-60 hover:bg-raised hover:opacity-100"
                                        )}
                                    >
                                        {group.id === "starred" ? (
                                            <StarIcon weight="fill" className="size-3.5 text-warning" />
                                        ) : (
                                            <HarnessMark harness={group.id} className="size-3.5" />
                                        )}
                                    </button>
                                }
                            />
                            <Tooltip.Content side="top">{group.label}</Tooltip.Content>
                        </Tooltip>
                    ))}
                </div>
            )}

            {/* As in the folder picker; the divider runs across the card's inset. */}
            <label className="-mx-1 mb-1 flex shrink-0 items-center gap-2 border-b border-border px-3.5">
                <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted/75" />
                <input
                    id={SEARCH_ID}
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        keyboardRef.current = false;
                        setActive(0);
                        listRef.current?.scrollTo({ top: 0 });
                    }}
                    onKeyDown={onKeyDown}
                    placeholder="Search models…"
                    aria-label="Search models"
                    aria-activedescendant={shown[active] ? `model-row-${active}` : undefined}
                    className={searchInputClassName}
                />
            </label>

            <div
                ref={listRef}
                role="listbox"
                aria-label="Models"
                style={{ maxHeight: VISIBLE_ROWS * ROW_PITCH }}
                className="hide-scrollbar flex flex-col gap-0.5 overflow-y-auto overscroll-contain"
            >
                {shown.length === 0 && (
                    <p className="px-2.5 py-3 text-center text-xs text-muted/75">No models match.</p>
                )}
                {shown.map((row, index) => (
                    <ModelRow
                        key={`${row.harness}:${row.model.id}`}
                        index={index}
                        row={row}
                        selected={isRow(row, harness, model)}
                        active={index === active}
                        onHover={() => {
                            keyboardRef.current = false;
                            setActive(index);
                        }}
                        onPick={() => pick(row)}
                        onStar={() => toggleFavorite(row.model.id)}
                    />
                ))}
            </div>

            {/* Fast mode and effort belong to the picked model, not the
                highlighted one: each model has its own. */}
            {(showFast || showEffort) && (
                <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-1">
                    {showFast && (
                        <FooterRow
                            label="Fast mode"
                            value={fast ? "On" : "Off"}
                            expanded={side === "fast"}
                            onClick={() => onToggleSide("fast")}
                        />
                    )}
                    {showEffort && (
                        <FooterRow
                            label="Reasoning"
                            value={reasoning && REASONING_LABELS[reasoning]}
                            expanded={side === "effort"}
                            onClick={() => onToggleSide("effort")}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/** A footer row: its setting and value, opening its choices beside the card. */
function FooterRow({
    label,
    value,
    expanded,
    onClick
}: {
    label: string;
    value: string | undefined;
    expanded: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-expanded={expanded}
            onClick={onClick}
            className={cn(
                footerButtonClassName,
                "h-8 rounded-md px-2 text-xs text-text hover:bg-raised aria-expanded:bg-hover"
            )}
        >
            <span>{label}</span>
            <span className="ml-auto text-muted/75">{value}</span>
            <CaretRightIcon className="size-3 text-muted/75" weight="bold" />
        </button>
    );
}

function ModelRow({
    index,
    row,
    selected,
    active,
    onHover,
    onPick,
    onStar
}: {
    index: number;
    row: Row;
    selected: boolean;
    active: boolean;
    onHover: () => void;
    onPick: () => void;
    onStar: () => void;
}) {
    const description = row.model.description;
    return (
        <div
            id={`model-row-${index}`}
            data-index={index}
            role="option"
            aria-selected={selected}
            onMouseMove={active ? undefined : onHover}
            onClick={onPick}
            className={cn(
                "group/row flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md pr-1 pl-2 select-none",
                "text-text transition-colors duration-100",
                selected ? "bg-hover" : active && "bg-raised"
            )}
        >
            <HarnessMark harness={row.harness} className="size-3.5 shrink-0" />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="max-w-full shrink-0 truncate text-xs font-medium">{row.model.label}</span>
                {/* The row under the pointer or the arrow keys says what it is. */}
                {active && description && (
                    <span className="min-w-0 truncate text-[11px] text-muted/75">{description}</span>
                )}
            </span>
            <button
                type="button"
                aria-label={`${row.favorite ? "Unstar" : "Star"} ${row.model.label}`}
                aria-pressed={row.favorite}
                onClick={(event) => {
                    event.stopPropagation();
                    onStar();
                }}
                className={cn(
                    "inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none",
                    "transition-[background-color,opacity] duration-150 hover:bg-border",
                    // Quiet until the row is hovered or the model is starred.
                    !row.favorite && !active && "opacity-0"
                )}
            >
                <StarIcon
                    weight={row.favorite ? "fill" : "regular"}
                    className={cn("size-3.5", row.favorite ? "text-warning" : "text-muted/75")}
                />
            </button>
        </div>
    );
}

/**
 * A footer row's choices (reasoning levels, fast mode on/off), opened from
 * the card's footer and set beside the card's bottom edge, level with the
 * row that opened it: `lift` raises it one row, for the row above the last.
 */
function SideCard<T extends string>({
    label,
    options,
    value,
    lift = false,
    onSelect
}: {
    label: string;
    options: readonly { id: T; label: string }[];
    value: T | undefined;
    lift?: boolean;
    onSelect: (value: T) => void;
}) {
    return (
        <div
            role="radiogroup"
            aria-label={label}
            style={lift ? { bottom: ROW_PITCH } : undefined}
            className={cn(
                "pointer-events-auto absolute right-full bottom-0 mr-2 w-44",
                "rounded-md border border-border bg-surface p-1 shadow-lg shadow-shadow/40",
                "transition-opacity duration-150 ease-out starting:opacity-0"
            )}
        >
            {options.map((option) => {
                const checked = option.id === value;
                return (
                    <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        onClick={() => onSelect(option.id)}
                        className={cn(
                            "grid h-8 w-full grid-cols-[1fr_1rem] items-center gap-x-2 rounded-md px-2.5",
                            "text-left text-xs text-text outline-none select-none",
                            "hover:bg-hover focus-visible:bg-hover"
                        )}
                    >
                        <span>{option.label}</span>
                        {checked && <CheckIcon className="size-3" weight="bold" />}
                    </button>
                );
            })}
        </div>
    );
}
