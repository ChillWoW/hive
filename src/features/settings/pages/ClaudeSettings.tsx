import { useState } from "react";
import { FolderOpenIcon } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/lib/platform";
import type { AccessMode } from "@/proto";
import { ACCESS_MODES } from "@/features/composer/access";
import { useComposerStore } from "@/features/composer/store";
import { Button, Input, NumberField, Select, Textarea } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { AccountSection, LocationRow, UsageSection } from "./ClaudeAccount";
import { useSetting } from "../store";

/**
 * Claude Code's settings under its header in Settings › Providers: its
 * account and plan usage, permissions, sessions, where its CLI is, and the
 * extras every `claude` gets.
 */
export function ClaudeSettings() {
    return (
        <>
            <AccountSection />
            <UsageSection />
            <AccessSection />
            <SessionsSection />
            <BinarySection />
            <AdvancedSection />
        </>
    );
}

function SessionsSection() {
    const idle = useSetting("chat", "idleTimeoutMinutes");
    const compactWindow = useSetting("claude", "autoCompactWindow");

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
        </SettingsSection>
    );
}

function BinarySection() {
    const binaryPath = useSetting("claude", "binaryPath");

    return (
        <SettingsSection title="Installation">
            <LocationRow />
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
                controlClassName="w-48"
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

/** A text field saved on blur or Enter; Escape restores the saved value. */
function CommitInput({ value, placeholder, onCommit }: { value: string; placeholder?: string; onCommit: (value: string) => void }) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
        setDraft(null);
    };
    return (
        <Input
            value={draft ?? value}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setDraft(null);
            }}
        />
    );
}

/** Lines of text saved on blur. */
function CommitTextarea({ value, placeholder, onCommit }: { value: string; placeholder?: string; onCommit: (value: string) => void }) {
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <Textarea
            value={draft ?? value}
            placeholder={placeholder}
            spellCheck={false}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
                if (draft !== null && draft !== value) onCommit(draft);
                setDraft(null);
            }}
            className="w-full"
        />
    );
}
