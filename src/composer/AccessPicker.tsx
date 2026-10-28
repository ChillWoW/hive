import { CheckIcon, ListChecksIcon } from "@phosphor-icons/react";
import type { ChatConfig } from "@/proto";
import { ACCESS_LABELS, resolveAccess, useCatalog } from "@/harnesses";
import { cn } from "@/lib/cn";
import { Menu, Switch } from "@/ui";
import { pickerTriggerClassName } from "./chip";

/**
 * What the agent may do without asking, beside the model picker: the access
 * modes the harness honors, each with what it allows, then the plan-mode
 * switch where the harness has one. The chip names the mode, with "Plan"
 * after it while plan mode is on, so a chat never runs with more access
 * than it says. Hidden until the catalog names the modes.
 */
export function AccessPicker({
    config,
    onChange
}: {
    config: ChatConfig;
    onChange: (config: ChatConfig) => void;
}) {
    const catalog = useCatalog(config.harness);
    if (!catalog || catalog.accessModes.length === 0) return null;

    const modes = catalog.accessModes;
    const current = resolveAccess(config.access, modes);
    const planOffered = catalog.capabilities.plan;
    const plan = config.plan && planOffered;

    return (
        <Menu>
            <Menu.Trigger
                aria-label="Access"
                className={cn(
                    pickerTriggerClassName,
                    "shrink-0 px-2",
                    current !== "full-access" && "text-dark-100"
                )}
            >
                <span className="whitespace-nowrap">{ACCESS_LABELS[current].label}</span>
                {/* A tinted pill, so plan mode reads as a state, not more text. */}
                {plan && (
                    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-info/15 pr-2 pl-1.5 text-xs font-medium whitespace-nowrap text-info">
                        <ListChecksIcon className="size-3" weight="bold" />
                        Plan
                    </span>
                )}
            </Menu.Trigger>
            <Menu.Content
                side="top"
                // The chip grows leftwards when the Plan pill appears (the
                // controls are right-aligned); its right edge stays put, so the
                // menu hangs from that one and doesn't jump.
                align="end"
                sideOffset={10}
                collisionPadding={12}
                className="w-64 min-w-0"
            >
                {modes.map((mode) => {
                    const selected = mode === current;
                    const { label, description } = ACCESS_LABELS[mode];
                    return (
                        <Menu.Item
                            key={mode}
                            onClick={() => {
                                if (!selected) onChange({ ...config, access: mode });
                            }}
                            className="grid grid-cols-[1fr_1rem] items-center gap-x-2"
                        >
                            <Row label={label} description={description} />
                            {selected && <CheckIcon className="size-3" weight="bold" />}
                        </Menu.Item>
                    );
                })}
                {/* An agent with one mode can't ask before acting: say so. */}
                {modes.length === 1 && (
                    <p className="px-2.5 py-1 text-[11px] text-dark-250">
                        {catalog.label} can't ask before acting, so it always runs with{" "}
                        {ACCESS_LABELS[modes[0]!].label.toLowerCase()}.
                    </p>
                )}
                {planOffered && (
                    <>
                        <Menu.Separator />
                        <Menu.Item
                            // A switch, not a pick: the menu stays open.
                            closeOnClick={false}
                            onClick={() => onChange({ ...config, plan: !plan })}
                            className="flex items-center gap-3"
                        >
                            <Row
                                label="Plan mode"
                                description="Plans before changing anything"
                            />
                            <Switch
                                checked={plan}
                                tabIndex={-1}
                                className="pointer-events-none ml-auto"
                            />
                        </Menu.Item>
                    </>
                )}
            </Menu.Content>
        </Menu>
    );
}

function Row({ label, description }: { label: string; description: string }) {
    return (
        <span className="flex min-w-0 flex-col">
            <span className="text-dark-50">{label}</span>
            <span className="text-[11px] text-dark-250">{description}</span>
        </span>
    );
}
