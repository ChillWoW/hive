import { cn } from "@/lib/cn";
import { HiveMark } from "@/ui";
import { CompletionMenu } from "./CompletionMenu";
import { ITEM_PREFIX } from "./slashCommands";
import type { SlashMenuState } from "./useSlashMenu";

/** The `/` and `$` menu: Hive's commands, the agent's, and its skills. */
export function SlashMenu({ menu, className }: { menu: SlashMenuState; className?: string }) {
    return (
        <CompletionMenu
            menu={menu}
            label={menu.kind === "skill" ? "Skills" : "Commands"}
            empty={
                menu.kind === "skill"
                    ? "No matching skill. Try / to browse commands."
                    : "No matching command."
            }
            itemKey={(item) => `${item.type}:${item.name}`}
            itemClassName="items-baseline"
            className={cn("max-h-64", className)}
            renderItem={(item) => (
                <>
                    <span className="max-w-[45%] shrink-0 truncate font-medium text-dark-50">
                        {ITEM_PREFIX[item.type]}
                        {item.name}
                    </span>
                    {item.type !== "app" && item.inputHint && (
                        <span className="shrink-0 text-dark-250">{item.inputHint}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-dark-200">
                        {item.description}
                    </span>
                    {item.type === "app" && (
                        <HiveMark className="size-3 shrink-0 self-center text-dark-250" />
                    )}
                    {item.type === "skill" && menu.kind === "command" && (
                        <span className="shrink-0 self-center rounded-sm bg-dark-700 px-1 text-[10px] leading-4 text-dark-200">
                            Skill
                        </span>
                    )}
                </>
            )}
        />
    );
}
