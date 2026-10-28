import { Combobox } from "@base-ui/react/combobox";
import {
    CaretDownIcon,
    CheckIcon,
    MagnifyingGlassIcon
} from "@phosphor-icons/react";
import type { ChatConfig, HarnessCatalog, Model } from "@/proto";
import {
    fitConfig,
    refreshCatalogs,
    resolveModel,
    useCatalog,
    useCatalogs
} from "@/harnesses";
import { cn } from "@/lib/cn";
import { usePortalContainer } from "@/ui";
import {
    pickerTriggerClassName,
    popupClassName,
    rowClassName,
    searchInputClassName
} from "./chip";

type Item = { harness: HarnessCatalog; model: Model };
type Group = { value: string; harness: HarnessCatalog; items: Item[] };

const keyOf = (item: Item) => `${item.harness.id}/${item.model.id}`;

function matches(item: Item, query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${item.model.label} ${item.model.id} ${item.harness.label}`
        .toLowerCase()
        .includes(q);
}

/**
 * Harness and model in one picker: models grouped under the harness that
 * runs them, so picking a model of another harness switches harness too.
 * A chat already started is `locked` to its harness and lists only its
 * models. A harness whose CLI isn't installed is listed but can't be picked.
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
    const container = usePortalContainer();
    const all = useCatalogs();
    const current = useCatalog(config.harness);
    const catalogs = locked ? (current ? [current] : []) : all;
    const model = resolveModel(current, config);

    const groups: Group[] = catalogs.map((harness) => ({
        value: harness.installed
            ? harness.label
            : `${harness.label} · not installed`,
        harness,
        items: harness.models.map((model) => ({ harness, model }))
    }));
    const selected =
        current && model ? { harness: current, model } : null;

    if (!selected) {
        return (
            <span className="h-8 truncate px-2.5 text-sm leading-8 text-dark-300 select-none">
                {current ? "No models" : "Loading…"}
            </span>
        );
    }

    return (
        <Combobox.Root
            items={groups}
            value={selected}
            onValueChange={(item: Item | null) => {
                if (!item) return;
                onChange(
                    fitConfig(item.harness, {
                        ...config,
                        harness: item.harness.id,
                        model: item.model.id
                    })
                );
            }}
            isItemEqualToValue={(a: Item, b: Item) => keyOf(a) === keyOf(b)}
            itemToStringLabel={(item: Item) => item.model.label}
            filter={matches}
            onOpenChange={(open) => {
                if (open) void refreshCatalogs();
            }}
        >
            <Combobox.Trigger
                aria-label="Model"
                className={pickerTriggerClassName}
            >
                {!locked && all.length > 1 && (
                    <span className="shrink-0 text-dark-300">
                        {selected.harness.label}
                    </span>
                )}
                <span className="truncate">{selected.model.label}</span>
                <CaretDownIcon className="size-3 shrink-0" weight="bold" />
            </Combobox.Trigger>

            <Combobox.Portal container={container ?? undefined}>
                <Combobox.Positioner
                    side="top"
                    align="start"
                    sideOffset={10}
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                    className="z-50 outline-none"
                >
                    <Combobox.Popup
                        aria-label="Choose a model"
                        className={cn(popupClassName, "w-72")}
                    >
                        <div className="flex items-center gap-2 border-b border-dark-600 px-2.5">
                            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-300" />
                            <Combobox.Input
                                placeholder="Search models"
                                className={searchInputClassName}
                            />
                        </div>

                        <Combobox.Empty className="px-2.5 py-3 text-center text-xs text-dark-300 empty:hidden">
                            No models match.
                        </Combobox.Empty>

                        <Combobox.List className="hide-scrollbar max-h-[min(22rem,calc(var(--available-height)-4rem))] overflow-y-auto overscroll-contain p-1 empty:hidden">
                            {(group: Group) => (
                                <Combobox.Group
                                    key={group.harness.id}
                                    items={group.items}
                                    className="pb-1 last:pb-0"
                                >
                                    <Combobox.GroupLabel className="sticky -top-1 z-10 bg-dark-850 px-2 pt-2 pb-1 text-[11px] font-medium text-dark-300 select-none">
                                        {group.value}
                                    </Combobox.GroupLabel>
                                    <Combobox.Collection>
                                        {(item: Item) => (
                                            <ModelItem key={keyOf(item)} item={item} />
                                        )}
                                    </Combobox.Collection>
                                </Combobox.Group>
                            )}
                        </Combobox.List>
                    </Combobox.Popup>
                </Combobox.Positioner>
            </Combobox.Portal>
        </Combobox.Root>
    );
}

function ModelItem({ item }: { item: Item }) {
    return (
        <Combobox.Item
            value={item}
            disabled={!item.harness.installed}
            className={cn(rowClassName, "grid-cols-[1fr_1rem] items-start")}
        >
            <span className="flex min-w-0 flex-col">
                <span className="truncate text-dark-50">{item.model.label}</span>
                {item.model.description && (
                    <span className="truncate text-[11px] text-dark-300">
                        {item.model.description}
                    </span>
                )}
            </span>
            <Combobox.ItemIndicator className="mt-0.5 text-dark-100">
                <CheckIcon className="size-3" weight="bold" />
            </Combobox.ItemIndicator>
        </Combobox.Item>
    );
}
