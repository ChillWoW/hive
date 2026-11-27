import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { backend } from "@/lib/backend";
import { tildify, untildify, useHomeDir } from "@/lib/home";
import { isTauri } from "@/lib/platform";
import { Select } from "@/ui";
import { CommitInput } from "../CommitFields";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";
import type { BranchNaming } from "../types";

/** `~`, `~/…`, `/…`, `C:\…` or `\\server\…`: what the backend takes as a location. */
function looksAbsolute(path: string): boolean {
    return /^(~([/\\]|$)|\/|[A-Za-z]:[/\\]|\\\\)/.test(path);
}

const NAMING: { value: BranchNaming; label: string }[] = [
    { value: "static", label: "Static prefix" },
    { value: "semantic", label: "Semantic prefix" }
];

/**
 * New chats' worktrees (picked under the composer): where they go, how
 * their branches are named, and whether deleting the chat takes the branch.
 */
export function WorktreesPage() {
    const location = useSetting("worktrees", "location");
    const naming = useSetting("worktrees", "branchNaming");
    const prefix = useSetting("worktrees", "branchPrefix");
    const deleteBranch = useSetting("worktrees", "deleteBranch");
    const home = useHomeDir();
    const [defaultDir, setDefaultDir] = useState("");

    useEffect(() => {
        void backend<string>("worktrees_default_dir", {}, () => "~/.outcode/worktrees").then(setDefaultDir, () => {});
    }, []);

    // Paths under the home folder are kept as `~…` (the backend expands them).
    const setLocation = (path: string) => location.set(tildify(path, home));
    const browse = async () => {
        const picked = await open({
            directory: true,
            defaultPath: untildify(location.value, home) || defaultDir || undefined,
            title: "Choose where worktrees go"
        });
        if (typeof picked === "string") setLocation(picked);
    };

    const invalidLocation = !!location.value && !looksAbsolute(location.value);
    const example = prefix.value ? `${prefix.value}/fix-login-bug` : "fix-login-bug";
    const semantic = naming.value === "semantic";

    return (
        <>
            <SettingsSection title="New worktrees">
                <SettingRow
                    label="Location"
                    description={
                        invalidLocation
                            ? "Not an absolute path, so the default is used"
                            : "Where new worktrees go; empty uses the default"
                    }
                    keywords="worktree folder directory path location where"
                    setting={location}
                    control={
                        <CommitInput
                            value={location.value}
                            onCommit={setLocation}
                            placeholder={tildify(defaultDir, home)}
                            label="Worktree location"
                            onBrowse={isTauri ? () => void browse() : undefined}
                        />
                    }
                />
                <SettingRow
                    label="Branch naming"
                    description={
                        semantic
                            ? "The text generation model picks the type and name, like fix/login-bug"
                            : "Every new branch starts with the same prefix"
                    }
                    keywords="worktree branch naming name prefix semantic static conventional type git"
                    setting={naming}
                    control={
                        <Select
                            items={NAMING}
                            value={naming.value}
                            onValueChange={(next: BranchNaming | null) => next && naming.set(next)}
                        >
                            <Select.Trigger aria-label="Branch naming">
                                <Select.Value />
                            </Select.Trigger>
                            <Select.Content>
                                {NAMING.map((option) => (
                                    <Select.Item key={option.value} value={option.value}>
                                        {option.label}
                                    </Select.Item>
                                ))}
                            </Select.Content>
                        </Select>
                    }
                />
                {!semantic && (
                    <SettingRow
                        label="Branch prefix"
                        description={`New branches look like ${example}. Empty for none`}
                        keywords="worktree branch prefix name namespace git"
                        setting={prefix}
                        control={
                            <CommitInput
                                value={prefix.value}
                                onCommit={prefix.set}
                                placeholder="None"
                                label="Branch prefix"
                            />
                        }
                    />
                )}
            </SettingsSection>

            <SettingsSection title="Deleting chats">
                <SwitchRow
                    label="Delete the branch"
                    description="Deleting a worktree chat deletes its branch too, merged or not"
                    keywords="worktree branch delete remove cleanup chat git"
                    setting={deleteBranch}
                />
            </SettingsSection>
        </>
    );
}
