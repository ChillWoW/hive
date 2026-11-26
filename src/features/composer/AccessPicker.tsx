import { useRef, useState } from "react";
import { CheckIcon, ClipboardTextIcon } from "@phosphor-icons/react";
import type { ChatConfig } from "@/proto";
import { cn } from "@/lib/cn";
import { Menu, Switch } from "@/ui";
import { pickerTriggerClassName } from "@/ui/chip";
import { ACCESS_MODES } from "./access";

const rowClassName = cn(
    "flex cursor-default items-center gap-3 rounded-sm px-2.5 py-1.5 outline-none select-none",
    "data-highlighted:bg-hover"
);

/**
 * What the agent may do without asking, and plan mode, in one chip: the
 * access modes with what each means (the picked one checked), then a plan
 * mode switch. A change reaches a running agent at once; Shift+Tab in the
 * field toggles plan mode too.
 */
export function AccessPicker({ config, onChange }: { config: ChatConfig; onChange: (config: ChatConfig) => void }) {
    const mode = ACCESS_MODES.find((m) => m.id === config.access) ?? ACCESS_MODES[2]!;
    const triggerRef = useRef<HTMLButtonElement>(null);
    // The chip's horizontal span when the menu opened: toggling plan mode
    // widens the chip, and the open menu shouldn't slide with it.
    const span = useRef<{ left: number; width: number } | null>(null);
    const [anchor] = useState(() => ({
        getBoundingClientRect: () => {
            const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect();
            const s = span.current;
            return s ? new DOMRect(s.left, rect.top, s.width, rect.height) : rect;
        },
    }));
    return (
        <Menu
            onOpenChange={(open) => {
                const rect = triggerRef.current?.getBoundingClientRect();
                if (open && rect) span.current = { left: rect.left, width: rect.width };
            }}
        >
            <Menu.Trigger
                ref={triggerRef}
                aria-label={`Access: ${mode.label}${config.plan ? ", plan mode" : ""}`}
                className={cn(pickerTriggerClassName, "gap-1.5")}
            >
                {config.plan && (
                    <span className="flex shrink-0 items-center gap-1 text-text">
                        <ClipboardTextIcon className="size-3.5" weight="fill" />
                        Plan
                        <span className="text-muted/60">·</span>
                    </span>
                )}
                <span className="truncate">{mode.label}</span>
            </Menu.Trigger>
            <Menu.Content side="top" align="center" sideOffset={10} anchor={anchor} className="w-64 p-1">
                {ACCESS_MODES.map((m) => (
                    <Menu.Item
                        key={m.id}
                        onClick={() => onChange({ ...config, access: m.id })}
                        className={rowClassName}
                    >
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="text-sm text-text">{m.label}</span>
                            <span className="text-xs text-muted">{m.description}</span>
                        </span>
                        {m.id === mode.id && <CheckIcon className="size-3.5 shrink-0 text-text" weight="bold" />}
                    </Menu.Item>
                ))}
                <Menu.Separator />
                <Menu.Item
                    closeOnClick={false}
                    onClick={() => onChange({ ...config, plan: !config.plan })}
                    className={rowClassName}
                >
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm text-text">Plan mode</span>
                        <span className="text-xs text-muted">Plans before changing anything</span>
                    </span>
                    <Switch
                        size="md"
                        checked={config.plan}
                        tabIndex={-1}
                        aria-hidden
                        className="pointer-events-none shrink-0"
                    />
                </Menu.Item>
            </Menu.Content>
        </Menu>
    );
}
