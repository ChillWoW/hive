import type { ReactNode } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { matchesQuery, splitMatches, useSettingsQuery } from "./search";
import type { SettingHandle } from "./store";

/** Marks each query word inside `text`. */
function Highlight({ text }: { text: string }) {
    const query = useSettingsQuery();
    if (!query) return <>{text}</>;

    return (
        <>
            {splitMatches(text, query).map((part, index) =>
                index % 2 === 1 ? (
                    <mark
                        key={index}
                        className="rounded-xs bg-warning/25 text-dark-50"
                    >
                        {part}
                    </mark>
                ) : (
                    part
                )
            )}
        </>
    );
}

/**
 * A titled group of rows on one card. When search hides every row inside,
 * the `:has()` rule hides the section too, so no empty heading is left behind.
 */
export function SettingsSection({
    title,
    children,
    className
}: {
    title?: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section
            className={cn(
                "flex flex-col gap-2.5 [&:not(:has([data-setting-row]))]:hidden",
                className
            )}
        >
            {title && (
                <h3 className="px-1 text-[13px] font-medium text-dark-100">
                    {title}
                </h3>
            )}
            <div className="flex flex-col rounded-md bg-dark-800">
                {children}
            </div>
        </section>
    );
}

/**
 * One setting: label and description on the left, control on the right.
 * Pass `setting` (from `useSetting`) to get the modified dot, which turns
 * into a reset button when hovered; `keywords` widens search without
 * cluttering the label.
 */
export function SettingRow({
    label,
    description,
    keywords,
    setting,
    control,
    stacked,
    className,
    controlClassName
}: {
    label: string;
    /** A short phrase, no full stop. */
    description?: ReactNode;
    keywords?: string;
    setting?: SettingHandle;
    control: ReactNode;
    /** Puts the control under the label, full width. */
    stacked?: boolean;
    className?: string;
    controlClassName?: string;
}) {
    const query = useSettingsQuery();
    const plainDescription =
        typeof description === "string" ? description : undefined;
    if (!matchesQuery(query, label, plainDescription, keywords)) return null;

    const modified = setting?.modified ?? false;

    return (
        <div
            data-setting-row
            data-modified={modified || undefined}
            className={cn(
                "relative flex min-h-13 gap-x-8 gap-y-3 px-4 py-3",
                // Hairline between rows, inset to the content.
                "not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-dark-600",
                stacked ? "flex-col" : "items-center justify-between",
                className
            )}
        >
            <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                    <span className="text-[13px] leading-5 font-medium text-dark-50">
                        <Highlight text={label} />
                    </span>
                    {modified && setting && (
                        <ResetMarker label={label} onReset={setting.reset} />
                    )}
                </div>
                {description && (
                    <span className="text-xs leading-4 text-dark-250">
                        {typeof description === "string" ? (
                            <Highlight text={description} />
                        ) : (
                            description
                        )}
                    </span>
                )}
            </div>

            <div
                className={cn(
                    "flex shrink-0 items-center",
                    stacked ? "w-full" : "w-48 justify-end",
                    controlClassName
                )}
            >
                {control}
            </div>
        </div>
    );
}

/** "Changed from default": a dot that becomes a reset arrow under the pointer. */
function ResetMarker({
    label,
    onReset
}: {
    label: string;
    onReset: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={`Reset ${label} to default`}
            onClick={onReset}
            className="group/reset relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-dark-200 hover:text-dark-50 focus-visible:text-dark-50"
        >
            <span className="size-1.5 rounded-full bg-info transition-[opacity,scale] duration-150 group-hover/reset:scale-0 group-hover/reset:opacity-0 group-focus-visible/reset:scale-0 group-focus-visible/reset:opacity-0" />
            <ArrowCounterClockwiseIcon
                weight="bold"
                className="absolute size-3 scale-50 opacity-0 transition-[opacity,scale] duration-150 group-hover/reset:scale-100 group-hover/reset:opacity-100 group-focus-visible/reset:scale-100 group-focus-visible/reset:opacity-100"
            />
        </button>
    );
}
