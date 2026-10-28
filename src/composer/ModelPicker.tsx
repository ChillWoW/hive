import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    CaretRightIcon,
    CheckIcon,
    MagnifyingGlassIcon,
    StarIcon
} from "@phosphor-icons/react";
import type { ChatConfig, HarnessCatalog, Model, ReasoningLevel } from "@/proto";
import {
    fitConfig,
    HarnessIcon,
    REASONING_LABELS,
    refreshCatalogs,
    resolveModel,
    resolveReasoning,
    useCatalog,
    useCatalogs
} from "@/harnesses";
import { cn } from "@/lib/cn";
import { settings } from "@/settings/store";
import { Popover, Tooltip, usePortalContainer } from "@/ui";
import {
    footerButtonClassName,
    pickerTriggerClassName,
    popupClassName,
    searchInputClassName
} from "./chip";
import { useComposerStore } from "./store";

/** A row is 32px plus the list's 2px gap; tabs and scrolling count in rows. */
const ROW_PITCH = 34;
/** Rows shown before the list scrolls. */
const VISIBLE_ROWS = 7;

type Row = { harness: HarnessCatalog; model: Model; key: string; favorite: boolean };
/** A run of rows the tab strip can jump to: the starred ones, then one per harness. */
type Group = { id: string; label: string; harness?: HarnessCatalog; start: number };

const keyOf = (harness: HarnessCatalog, model: Model) => `${harness.id}/${model.id}`;

function matches(row: Row, query: string) {
    return `${row.model.label} ${row.model.id} ${row.harness.label}`
        .toLowerCase()
        .includes(query);
}

/**
 * Model and reasoning effort in one picker. The chip names the model with
 * its harness's mark and the effort after it (models without levels have none).
 *
 * The card lists models under provider tabs (starred models first), with a
 * search above and a Reasoning row below, which opens the picked model's
 * levels in a card beside it. A model's effort defaults to High (else Medium,
 * else its first level); there is no "let the CLI decide". Picking a model
 * keeps the card open so its effort can be set next. A chat
 * already started is `locked` to its harness and lists only its models; a
 * harness whose CLI isn't installed is listed, and picking it opens Settings › Providers.
 */
export function ModelPicker({
    config,
    onChange,
    locked = false
}: {
    config: ChatConfig;
    onChange: (config: ChatConfig) => void;
    locked?: boolean;
}) {
    const all = useCatalogs();
    const current = useCatalog(config.harness);
    const model = resolveModel(current, config);
    const reasoning = resolveReasoning(model, config);
    const container = usePortalContainer();
    const [open, setOpen] = useState(false);
    const [effortOpen, setEffortOpen] = useState(false);

    if (!current || !model) {
        return (
            <span className="h-8 truncate px-2.5 text-sm leading-8 text-dark-300 select-none">
                {current ? "No models" : "Loading…"}
            </span>
        );
    }

    const catalogs = locked ? [current] : all;

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) void refreshCatalogs();
                else setEffortOpen(false);
            }}
        >
            <Popover.Trigger
                aria-label={`Model: ${model.label}`}
                className={cn(pickerTriggerClassName, "gap-1.5")}
            >
                <HarnessIcon harness={current.id} className="size-3.5 shrink-0" />
                <span className="truncate">{model.label}</span>
                {reasoning && (
                    // Yields first under pressure, so the model name truncates last.
                    <span className="min-w-0 shrink-[1000] truncate text-dark-300">
                        {REASONING_LABELS[reasoning]}
                    </span>
                )}
            </Popover.Trigger>
            <Popover.Portal container={container ?? undefined}>
                <Popover.Positioner
                    side="top"
                    align="end"
                    sideOffset={10}
                    // The extra room on top keeps it off the top bar, the
                    // window's drag handle.
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                >
                    <Popover.Popup
                        aria-label="Choose a model"
                        initialFocus={() => document.getElementById(SEARCH_ID)}
                        className={cn(popupClassName, "w-72 min-w-0 rounded-xl p-1")}
                    >
                        <ModelCard
                            catalogs={catalogs}
                            config={config}
                            current={current}
                            model={model}
                            onChange={onChange}
                            effortOpen={effortOpen}
                            onToggleEffort={() => setEffortOpen((o) => !o)}
                        />
                    </Popover.Popup>
                    {/* A sibling of the popup, which clips its overflow; the
                        positioner is what it's placed against. */}
                    {effortOpen && model.reasoningLevels.length > 0 && (
                        <EffortCard
                            levels={model.reasoningLevels}
                            value={reasoning}
                            onSelect={(reasoning) => {
                                onChange({ ...config, reasoning });
                                setEffortOpen(false);
                            }}
                        />
                    )}
                </Popover.Positioner>
            </Popover.Portal>
        </Popover>
    );
}

const SEARCH_ID = "model-picker-search";

function ModelCard({
    catalogs,
    config,
    current,
    model,
    onChange,
    effortOpen,
    onToggleEffort
}: {
    catalogs: HarnessCatalog[];
    config: ChatConfig;
    current: HarnessCatalog;
    model: Model;
    onChange: (config: ChatConfig) => void;
    effortOpen: boolean;
    onToggleEffort: () => void;
}) {
    const reasoning = resolveReasoning(model, config);
    const favorites = useComposerStore((s) => s.favorites);
    const toggleFavorite = useComposerStore((s) => s.toggleFavorite);
    const [query, setQuery] = useState("");
    const listRef = useRef<HTMLDivElement>(null);

    // Starred models first, then each harness's own, in catalog order.
    const { rows, groups } = useMemo(() => {
        const starred: Row[] = [];
        const rest: Row[][] = [];
        for (const harness of catalogs) {
            const own: Row[] = [];
            for (const m of harness.models) {
                const key = keyOf(harness, m);
                const row = { harness, model: m, key, favorite: favorites.includes(key) };
                (row.favorite ? starred : own).push(row);
            }
            rest.push(own);
        }
        const groups: Group[] = [];
        let start = 0;
        if (starred.length) {
            groups.push({ id: "starred", label: "Starred", start });
            start += starred.length;
        }
        catalogs.forEach((harness, i) => {
            if (!rest[i]!.length) return;
            groups.push({ id: harness.id, label: harness.label, harness, start });
            start += rest[i]!.length;
        });
        return { rows: [...starred, ...rest.flat()], groups };
    }, [catalogs, favorites]);

    const q = query.trim().toLowerCase();
    const shown = q ? rows.filter((row) => matches(row, q)) : rows;
    const selectedKey = keyOf(current, model);
    const selectedIndex = shown.findIndex((row) => row.key === selectedKey);
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
        // Settings › Providers can install it.
        if (!row.harness.installed) return settings.open("providers");
        if (row.key !== selectedKey) {
            onChange(
                fitConfig(row.harness, {
                    ...config,
                    harness: row.harness.id,
                    model: row.model.id
                })
            );
        }
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
    // first row, and hovering or arrowing through rows moves it along. (Not
    // the scroll position: a list too short to scroll never reaches a later
    // group's start.)
    const viewed = [...groups].reverse().find((g) => g.start <= active)?.id;

    return (
        <div className="flex flex-col">
            {/* Searching flattens the list, so the tabs step aside. */}
            {!q && groups.length > 0 && (
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
                                            "inline-flex size-8 shrink-0 items-center justify-center rounded-[7px] outline-none",
                                            "transition-[background-color,opacity] duration-150",
                                            viewed === group.id
                                                ? "bg-dark-700"
                                                : "opacity-60 hover:bg-dark-800 hover:opacity-100"
                                        )}
                                    >
                                        {group.harness ? (
                                            <HarnessIcon harness={group.harness.id} className="size-3.5" />
                                        ) : (
                                            <StarIcon weight="fill" className="size-3.5 text-warning" />
                                        )}
                                    </button>
                                }
                            />
                            <Tooltip.Content side="top">{group.label}</Tooltip.Content>
                        </Tooltip>
                    ))}
                </div>
            )}

            {/* As in the project picker; the divider runs across the card's inset. */}
            <label className="-mx-1 mb-1 flex shrink-0 items-center gap-2 border-b border-dark-600 px-3.5">
                <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-300" />
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
                    <p className="px-2.5 py-3 text-center text-xs text-dark-300">
                        No models match.
                    </p>
                )}
                {shown.map((row, index) => (
                    <ModelRow
                        key={row.key}
                        index={index}
                        row={row}
                        selected={row.key === selectedKey}
                        active={index === active}
                        onHover={() => {
                            keyboardRef.current = false;
                            setActive(index);
                        }}
                        onPick={() => pick(row)}
                        onStar={() => toggleFavorite(row.key)}
                    />
                ))}
            </div>

            {/* Effort belongs to the picked model, not the highlighted one:
                each model has its own levels. */}
            {model.reasoningLevels.length > 0 && (
                <div className="mt-1 border-t border-dark-600 pt-1">
                    <button
                        type="button"
                        aria-expanded={effortOpen}
                        onClick={onToggleEffort}
                        className={cn(
                            footerButtonClassName,
                            "h-8 rounded-[7px] px-2 text-sm text-dark-50 hover:bg-dark-800 aria-expanded:bg-dark-700"
                        )}
                    >
                        <span>Reasoning</span>
                        <span className="ml-auto text-dark-300">
                            {reasoning && REASONING_LABELS[reasoning]}
                        </span>
                        <CaretRightIcon className="size-3 text-dark-300" weight="bold" />
                    </button>
                </div>
            )}
        </div>
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
    const disabled = !row.harness.installed;
    const description = disabled
        ? `${row.harness.label} isn't installed · set it up in Settings`
        : row.model.description;
    return (
        <div
            id={`model-row-${index}`}
            data-index={index}
            role="option"
            aria-selected={selected}
            aria-disabled={disabled || undefined}
            onMouseMove={active ? undefined : onHover}
            onClick={onPick}
            className={cn(
                "group/row flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-[7px] pr-1 pl-2 select-none",
                "text-dark-50 transition-colors duration-100",
                selected
                    ? "bg-dark-700"
                    : active && "bg-dark-800",
                disabled && "opacity-50"
            )}
        >
            <HarnessIcon harness={row.harness.id} className="size-3.5 shrink-0" />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="max-w-full shrink-0 truncate text-xs font-medium">
                    {row.model.label}
                </span>
                {/* The row under the pointer or the arrow keys says what it is. */}
                {active && description && (
                    <span className="min-w-0 truncate text-[11px] text-dark-250">
                        {description}
                    </span>
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
                    "transition-[background-color,opacity] duration-150 hover:bg-dark-600",
                    // Quiet until the row is hovered or the model is starred.
                    !row.favorite && !active && "opacity-0"
                )}
            >
                <StarIcon
                    weight={row.favorite ? "fill" : "regular"}
                    className={cn("size-3.5", row.favorite ? "text-warning" : "text-dark-300")}
                />
            </button>
        </div>
    );
}

/**
 * The picked model's reasoning levels, opened from the card's footer and set
 * beside the card's bottom edge, level with the button that opened it.
 * Highest first, so the list reads the way the effort grows.
 */
function EffortCard({
    levels,
    value,
    onSelect
}: {
    levels: ReasoningLevel[];
    value: ReasoningLevel | undefined;
    onSelect: (level: ReasoningLevel) => void;
}) {
    const options = [...levels].reverse();
    return (
        <div
            role="radiogroup"
            aria-label="Reasoning effort"
            className={cn(
                "pointer-events-auto absolute right-full bottom-0 mr-2 w-44",
                "rounded-xl border border-dark-600 bg-dark-850 p-1 shadow-lg shadow-black/40",
                "transition-opacity duration-150 ease-out starting:opacity-0"
            )}
        >
            {options.map((level) => {
                const checked = level === value;
                return (
                    <button
                        key={level}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        onClick={() => onSelect(level)}
                        className={cn(
                            "grid h-8 w-full grid-cols-[1fr_1rem] items-center gap-x-2 rounded-[7px] px-2.5",
                            "text-left text-sm text-dark-50 outline-none select-none",
                            "hover:bg-dark-700 focus-visible:bg-dark-700"
                        )}
                    >
                        <span>{REASONING_LABELS[level]}</span>
                        {checked && <CheckIcon className="size-3" weight="bold" />}
                    </button>
                );
            })}
        </div>
    );
}
