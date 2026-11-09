import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Switch } from "@/ui/Switch";
import type { SettingHandle } from "./store";

/** The hairline between a card's rows, inset to the content. */
const ROW_DIVIDER =
    "not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-border";

/** A titled group of rows on one card. */
export function SettingsSection({
    title,
    action,
    children
}: {
    title?: string;
    /** Beside the title, on the right. */
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="flex flex-col gap-2.5">
            {(title || action) && (
                <div className={cn("flex items-center gap-2 px-1", action && "min-h-6")}>
                    <h3 className="min-w-0 flex-1 text-[13px] font-medium text-muted">
                        {title}
                    </h3>
                    {action}
                </div>
            )}
            <div className="flex flex-col rounded-md bg-surface">{children}</div>
        </section>
    );
}

/**
 * One setting: label and description on the left, control on the right.
 * Pass `setting` (from `useSetting`) to get the modified dot, which turns
 * into a reset button when hovered.
 */
export function SettingRow({
    label,
    description,
    setting,
    control
}: {
    label: string;
    /** A short phrase, no full stop. */
    description?: ReactNode;
    setting?: SettingHandle;
    control: ReactNode;
}) {
    return (
        <div className={cn("relative flex min-h-13 items-center justify-between gap-x-8 px-4 py-3", ROW_DIVIDER)}>
            <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                    <span className="text-[13px] leading-5 font-medium text-text">
                        {label}
                    </span>
                    {setting?.modified && <ResetMarker label={label} onReset={setting.reset} />}
                </div>
                {description && (
                    <span className="truncate text-xs leading-4 text-muted">
                        {description}
                    </span>
                )}
            </div>
            <div className="flex w-48 shrink-0 items-center justify-end">{control}</div>
        </div>
    );
}

/** A `SettingRow` whose control is a switch bound to `setting`. */
export function SwitchRow({
    setting,
    ...row
}: Omit<Parameters<typeof SettingRow>[0], "control" | "setting"> & {
    setting: SettingHandle & { value: boolean; set: (value: boolean) => void };
}) {
    return (
        <SettingRow
            {...row}
            setting={setting}
            control={
                <Switch
                    checked={setting.value}
                    onCheckedChange={setting.set}
                    aria-label={row.label}
                />
            }
        />
    );
}

/** "Changed from default": a dot that becomes a reset arrow under the pointer. */
function ResetMarker({ label, onReset }: { label: string; onReset: () => void }) {
    return (
        <button
            type="button"
            aria-label={`Reset ${label} to default`}
            title="Reset to default"
            onClick={onReset}
            className="group/reset relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted hover:text-text"
        >
            <span className="size-1.5 rounded-full bg-accent transition-[opacity,scale] duration-150 group-hover/reset:scale-0 group-hover/reset:opacity-0" />
            <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="absolute size-3 scale-50 opacity-0 transition-[opacity,scale] duration-150 group-hover/reset:scale-100 group-hover/reset:opacity-100"
            >
                <path d="M2.5 3v3.5H6" />
                <path d="M3 9.5a5 5 0 1 0 .9-4.6L2.5 6.5" />
            </svg>
        </button>
    );
}
