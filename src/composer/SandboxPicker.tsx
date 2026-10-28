import { CheckIcon } from "@phosphor-icons/react";
import type { ChatConfig } from "@/proto";
import { SANDBOX_LEVELS, useCatalog } from "@/harnesses";
import { cn } from "@/lib/cn";
import { Menu } from "@/ui";
import { chipTriggerClassName } from "./chip";

/** What the agent may do without asking, from the levels its harness supports. */
export function SandboxPicker({
    config,
    onChange
}: {
    config: ChatConfig;
    onChange: (config: ChatConfig) => void;
}) {
    const catalog = useCatalog(config.harness);
    const levels = catalog?.sandboxLevels ?? [config.sandbox];
    const { label, icon: LevelIcon } = SANDBOX_LEVELS[config.sandbox];

    return (
        <Menu>
            <Menu.Trigger
                aria-label="Permissions"
                className={cn(
                    chipTriggerClassName,
                    "shrink-0",
                    config.sandbox === "danger-full-access" && "text-warning"
                )}
            >
                <LevelIcon className="size-3.5 shrink-0" />
                {label}
            </Menu.Trigger>
            <Menu.Content
                side="top"
                align="end"
                sideOffset={8}
                collisionPadding={12}
                className="w-64 min-w-0"
            >
                {levels.map((level) => {
                    const { label, description, icon: ItemIcon } =
                        SANDBOX_LEVELS[level];
                    const selected = level === config.sandbox;
                    return (
                        <Menu.Item
                            key={level}
                            onClick={() => {
                                if (!selected) onChange({ ...config, sandbox: level });
                            }}
                            className="grid grid-cols-[0.875rem_1fr_1rem] items-start gap-x-2"
                        >
                            <ItemIcon className="mt-0.5 size-3.5 text-dark-200" />
                            <span className="flex min-w-0 flex-col">
                                <span className="text-dark-50">{label}</span>
                                <span className="text-[11px] text-dark-300">
                                    {description}
                                </span>
                            </span>
                            {selected && (
                                <CheckIcon className="mt-0.5 size-3" weight="bold" />
                            )}
                        </Menu.Item>
                    );
                })}
            </Menu.Content>
        </Menu>
    );
}
