import { useState } from "react";
import { FolderOpenIcon } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/lib/platform";
import type { AccessMode } from "@/proto";
import { ACCESS_MODES } from "@/features/composer/access";
import { useComposerStore } from "@/features/composer/store";
import { Button, Input, NumberField, Select } from "@/ui";
import { CommitInput, CommitTextarea } from "../CommitFields";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { claude } from "@/features/claude/store";
import { AccountSection, LocationRow, UsageSection } from "./ProviderSections";
import { useSetting } from "../store";
import type { IdleCompaction } from "../types";

/**
 * Claude Code's settings under its header in Settings › Providers: its
 * account and plan usage, permissions, sessions, where its CLI is, and the
 * extras every `claude` gets.
 */
export function ClaudeSettings() {
    return (
        <>
            <AccountSection provider={claude} label="Claude account" />
            <UsageSection provider={claude} signedOutHint="Shown for a Claude subscription login" dock="claude" />
            <AccessSection />
            <SessionsSection />
            <ContextSection />
            <BinarySection />
            <AdvancedSection />
        </>
    );
}

function SessionsSection() {
    const idle = useSetting("chat", "idleTimeoutMinutes");

    return (
        <SettingsSection title="General">
            <SettingRow
                label="Close idle sessions after"
                description="An idle chat's Claude process stops; the next prompt resumes it"
                keywords="idle timeout minutes session process close resume"
                setting={idle}
                controlClassName="w-36"
                control={
                    <NumberField
                        aria-label="Idle timeout in minutes"
                        value={idle.value}
                        min={1}
                        max={1440}
                        step={1}
                        format={{ style: "unit", unit: "minute", unitDisplay: "short", maximumFractionDigits: 0 }}
                        onValueChange={(value) => value != null && idle.set(value)}
                    />
                }
            />
        </SettingsSection>
    );
}

const IDLE_COMPACTION: { value: IdleCompaction; label: string }[] = [
    { value: "on-return", label: "When I return" },
    { value: "before-cache-expires", label: "Before the cache expires" },
    { value: "off", label: "Never" }
];

const IDLE_COMPACTION_HINT: Record<IdleCompaction, string> = {
    "on-return": "Over 200k tokens and idle past the prompt cache: the next prompt compacts first",
    "before-cache-expires": "Over 200k tokens: compacted just before the prompt cache expires, while Outcode is open",
    off: "Coming back to a big idle chat re-reads all of it uncached"
};

/** When Claude summarizes a conversation: by itself as it fills up, and after sitting idle. */
function ContextSection() {
    const compactWindow = useSetting("claude", "autoCompactWindow");
    const idle = useSetting("claude", "idleCompaction");

    return (
        <SettingsSection title="Context">
            <SettingRow
                label="Compact the conversation at"
                description="Context size in tokens to summarize at; 0 keeps the default"
                keywords="auto compact window context tokens compaction summarize"
                setting={compactWindow}
                controlClassName="w-40"
                control={
                    <NumberField
                        aria-label="Auto-compact window in tokens"
                        value={compactWindow.value}
                        min={0}
                        max={2000000}
                        step={10000}
                        onValueChange={(value) => value != null && compactWindow.set(value)}
                    />
                }
            />
            <SettingRow
                label="Compact idle chats"
                description={IDLE_COMPACTION_HINT[idle.value]}
                keywords="compact compaction idle stale prompt cache expired expires return resume tokens cost"
                setting={idle}
                control={
                    <Select
                        items={IDLE_COMPACTION}
                        value={idle.value}
                        onValueChange={(next: IdleCompaction | null) => next && idle.set(next)}
                    >
                        <Select.Trigger aria-label="Compact idle chats">
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {IDLE_COMPACTION.map((option) => (
                                <Select.Item key={option.value} value={option.value}>
                                    {option.label}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                }
            />
        </SettingsSection>
    );
}

function BinarySection() {
    const binaryPath = useSetting("claude", "binaryPath");

    return (
        <SettingsSection title="Installation">
            <LocationRow provider={claude} />
            <SettingRow
                label="Claude binary"
                description="Leave empty to find claude on PATH"
                keywords="claude code binary path executable cli location override"
                setting={binaryPath}
                controlClassName="w-72"
                control={<PathInput value={binaryPath.value} onCommit={binaryPath.set} />}
            />
        </SettingsSection>
    );
}

/** A path typed in (saved on blur or Enter) or picked from a file dialog. */
function PathInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
        setDraft(null);
    };
    const browse = async () => {
        const picked = await open({ multiple: false, directory: false, title: "Claude binary" });
        if (typeof picked === "string") onCommit(picked);
    };

    return (
        <Input.Group>
            <Input
                value={draft ?? value}
                placeholder="Auto-detect"
                aria-label="Claude binary"
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setDraft(null);
                }}
            />
            {isTauri && (
                <Input.Addon>
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Browse"
                        onClick={() => void browse()}
                        className="size-6 text-muted hover:text-text"
                    >
                        <FolderOpenIcon />
                    </Button>
                </Input.Addon>
            )}
        </Input.Group>
    );
}

/** What a new chat's agent may do without asking; each chat can change it in its composer. */
function AccessSection() {
    const access = useSetting("claude", "defaultAccess");
    const items = ACCESS_MODES.map((m) => ({ value: m.id, label: m.label }));

    return (
        <SettingsSection title="Permissions">
            <SettingRow
                label="Default access"
                description="What the agent may do without asking"
                keywords="access permissions approval supervised auto accept edits full access default"
                setting={access}
                control={
                    <Select
                        items={items}
                        value={access.value}
                        onValueChange={(next: AccessMode | null) => {
                            if (next === null) return;
                            access.set(next);
                            // The next chat starts on the new default.
                            const picked = useComposerStore.getState().newChatConfig;
                            if (picked) useComposerStore.getState().setNewChatConfig({ ...picked, access: next });
                        }}
                    >
                        <Select.Trigger aria-label="Default access">
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {items.map((item) => (
                                <Select.Item key={item.value} value={item.value}>
                                    {item.label}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                }
            />
        </SettingsSection>
    );
}

/** Applied to every `claude` Outcode starts; a running chat picks them up from its next session. */
function AdvancedSection() {
    const launchArgs = useSetting("claude", "launchArgs");
    const env = useSetting("claude", "env");
    const configDir = useSetting("claude", "configDir");

    return (
        <SettingsSection title="Advanced">
            <SettingRow
                label="Launch arguments"
                description="Extra flags passed to claude"
                keywords="launch args arguments flags command line cli"
                setting={launchArgs}
                controlClassName="w-72"
                control={<CommitInput value={launchArgs.value} placeholder="--add-dir ../shared" onCommit={launchArgs.set} />}
            />
            <SettingRow
                label="Environment"
                description="Extra variables for claude, one KEY=value per line"
                keywords="environment variables env proxy api key"
                setting={env}
                controlClassName="w-72"
                control={<CommitTextarea value={env.value} placeholder="HTTPS_PROXY=http://proxy:8080" onCommit={env.set} />}
            />
            <SettingRow
                label="Config folder"
                description="CLAUDE_CONFIG_DIR; empty uses ~/.claude"
                keywords="config dir folder claude_config_dir profile account"
                setting={configDir}
                controlClassName="w-72"
                control={<CommitInput value={configDir.value} placeholder="~/.claude" onCommit={configDir.set} />}
            />
        </SettingsSection>
    );
}
