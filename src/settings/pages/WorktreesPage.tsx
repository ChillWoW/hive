import { useEffect, useState, type ComponentProps } from "react";
import { FolderOpenIcon } from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/cn";
import { tildify, untildify, useHomeDir } from "@/lib/home";
import { isTauri } from "@/lib/platform";
import { iconButtonClassName, Input, Switch, Tooltip } from "@/ui";
import { settingsApi } from "../api";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

/** `~`, `~/…`, `/…`, `C:\…` or `\\server\…`; what Rust accepts as a location. */
function looksAbsolute(path: string): boolean {
    return /^(~([/\\]|$)|\/|[A-Za-z]:[/\\]|\\\\)/.test(path);
}

/**
 * A text setting that's saved when the field loses focus or on Enter, not
 * per keystroke; Escape puts the saved value back.
 */
function DraftInput({
    value,
    onCommit,
    ...props
}: { value: string; onCommit: (value: string) => void } & Omit<
    ComponentProps<typeof Input>,
    "value" | "onChange"
>) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);

    const commit = () => {
        const next = draft.trim();
        if (next !== value) onCommit(next);
        else setDraft(value);
    };

    return (
        <Input
            size="sm"
            spellCheck={false}
            autoComplete="off"
            {...props}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                } else if (event.key === "Escape" && draft !== value) {
                    // Keeps the settings modal open.
                    event.preventDefault();
                    event.stopPropagation();
                    setDraft(value);
                }
            }}
        />
    );
}

export function WorktreesPage() {
    const location = useSetting("worktrees", "location");
    const prefix = useSetting("worktrees", "branchPrefix");
    const deleteBranch = useSetting("worktrees", "deleteBranch");
    const [defaultDir, setDefaultDir] = useState("");
    const home = useHomeDir();

    useEffect(() => {
        void settingsApi.defaultWorktreesDir().then(setDefaultDir, () => {});
    }, []);

    // Paths under the home folder are kept as `~…` (Rust expands them).
    const setLocation = (path: string) => location.set(tildify(path, home));

    const browse = async () => {
        const picked = await openDialog({
            directory: true,
            defaultPath: untildify(location.value, home) || defaultDir || undefined,
            title: "Choose where worktrees go"
        });
        if (typeof picked === "string") setLocation(picked);
    };

    const invalidLocation = !!location.value && !looksAbsolute(location.value);
    const example = prefix.value ? `${prefix.value}/fix-login-bug` : "fix-login-bug";

    return (
        <>
            <SettingsSection title="New worktrees">
                <SettingRow
                    label="Worktree location"
                    description={
                        invalidLocation
                            ? "Not an absolute path, so the default is used"
                            : "The folder new worktrees go in. Empty uses the default"
                    }
                    keywords="worktree folder directory path location where"
                    setting={location}
                    control={
                        <DraftInput
                            value={location.value}
                            onCommit={setLocation}
                            placeholder={tildify(defaultDir, home)}
                            invalid={invalidLocation}
                            aria-label="Worktree location"
                            rightIcon={
                                isTauri && (
                                    <Tooltip>
                                        <Tooltip.Trigger
                                            render={
                                                <button
                                                    type="button"
                                                    aria-label="Choose a folder"
                                                    onClick={() => void browse()}
                                                    className={cn(iconButtonClassName, "-mr-1 size-5")}
                                                >
                                                    <FolderOpenIcon className="size-3.5" />
                                                </button>
                                            }
                                        />
                                        <Tooltip.Content side="left">Choose a folder</Tooltip.Content>
                                    </Tooltip>
                                )
                            }
                        />
                    }
                />
                <SettingRow
                    label="Branch prefix"
                    description={`New branches look like ${example}. Empty for none`}
                    keywords="worktree branch prefix name namespace git"
                    setting={prefix}
                    control={
                        <DraftInput
                            value={prefix.value}
                            onCommit={prefix.set}
                            placeholder="None"
                            aria-label="Branch prefix"
                        />
                    }
                />
            </SettingsSection>

            <SettingsSection title="Deleting chats">
                <SettingRow
                    label="Delete the branch"
                    description="Deleting a worktree chat deletes its branch too, merged or not"
                    keywords="worktree branch delete remove cleanup chat git"
                    setting={deleteBranch}
                    control={
                        <Switch
                            checked={deleteBranch.value}
                            onCheckedChange={deleteBranch.set}
                            aria-label="Delete the branch"
                        />
                    }
                />
            </SettingsSection>
        </>
    );
}
