import { BrainIcon, CheckIcon } from "@phosphor-icons/react";
import type { ChatConfig, ReasoningLevel } from "@/proto";
import { REASONING_LABELS, resolveModel, useCatalog } from "@/harnesses";
import { cn } from "@/lib/cn";
import { Menu } from "@/ui";
import { pickerTriggerClassName } from "./chip";

/**
 * How hard the model thinks, from the levels the picked model takes;
 * hidden for a model that takes none. "Auto" leaves it to the CLI.
 */
export function ReasoningPicker({
    config,
    onChange
}: {
    config: ChatConfig;
    onChange: (config: ChatConfig) => void;
}) {
    const catalog = useCatalog(config.harness);
    const levels = resolveModel(catalog, config)?.reasoningLevels ?? [];
    if (levels.length === 0) return null;

    // Highest first, so the list reads the way the effort grows.
    const options: (ReasoningLevel | undefined)[] = [
        ...[...levels].reverse(),
        undefined
    ];

    return (
        <Menu>
            <Menu.Trigger
                aria-label="Reasoning effort"
                className={cn(pickerTriggerClassName, "shrink-0 px-2")}
            >
                <BrainIcon className="size-3.5 shrink-0" />
                <span>
                    {config.reasoning
                        ? REASONING_LABELS[config.reasoning]
                        : "Auto"}
                </span>
            </Menu.Trigger>
            <Menu.Content
                side="top"
                align="start"
                sideOffset={10}
                collisionPadding={12}
                className="w-40 min-w-0"
            >
                <Menu.GroupLabel>Reasoning</Menu.GroupLabel>
                {options.map((level) => {
                    const selected = level === config.reasoning;
                    return (
                        <Menu.Item
                            key={level ?? "default"}
                            onClick={() => {
                                if (!selected) onChange({ ...config, reasoning: level });
                            }}
                            className="grid grid-cols-[1fr_1rem] text-dark-100"
                        >
                            <span>
                                {level ? REASONING_LABELS[level] : "Auto"}
                            </span>
                            {selected && <CheckIcon className="size-3" weight="bold" />}
                        </Menu.Item>
                    );
                })}
            </Menu.Content>
        </Menu>
    );
}
