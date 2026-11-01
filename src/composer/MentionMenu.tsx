import { cn } from "@/lib/cn";
import { FileIcon } from "@/ui";
import { CompletionMenu } from "./CompletionMenu";
import type { MentionMenuState } from "./useMentionMenu";

/** The `@` menu: the matching files and folders, each with its parent folder. */
export function MentionMenu({ menu, className }: { menu: MentionMenuState; className?: string }) {
    return (
        <CompletionMenu
            menu={menu}
            label="Files"
            empty={menu.loading ? "Listing files…" : "No matching files"}
            itemKey={(entry) => entry.path}
            itemClassName="min-w-0 items-center"
            className={cn("max-h-72", className)}
            renderItem={(entry) => {
                const slash = entry.path.lastIndexOf("/");
                const name = entry.path.slice(slash + 1);
                const parent = slash === -1 ? "" : entry.path.slice(0, slash);
                return (
                    <>
                        <FileIcon name={name} folder={entry.dir} className="size-3.5" />
                        <span className="max-w-[70%] shrink-0 truncate text-dark-50">
                            {name}
                            {entry.dir && "/"}
                        </span>
                        {parent && (
                            <span className="min-w-0 truncate text-dark-250">{parent}</span>
                        )}
                    </>
                );
            }}
        />
    );
}
