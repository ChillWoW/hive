import { useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { refreshCatalogs } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { HarnessId, IdleCompaction } from "@/proto";
import { refreshProvider } from "@/providers";
import { Menu } from "@/ui";
import { DraftInput } from "../DraftInput";
import { SettingRow } from "../SettingsSection";
import { useSetting, useSettingsStore } from "../store";

/**
 * A harness's own settings (after t3code's provider settings): its name in
 * pickers, which binary runs, its config folder, extra launch arguments and
 * environment variables; for Claude, when it compacts. Rust applies them
 * live (`hive_harness::overrides`) to runs started from then on.
 */
export function ProviderRuntime({ harness }: { harness: HarnessId }) {
    useReprobe(harness);
    switch (harness) {
        case "claude-code":
            return <ClaudeRuntime />;
        case "codex":
            return <CodexRuntime />;
        case "opencode":
            return <OpencodeRuntime />;
        default:
            return null;
    }
}

/** What a provider's status and the catalogs depend on, per harness. */
function useRuntimeKey(harness: HarnessId): string {
    return useSettingsStore((s) => {
        const { claude, codex, opencode } = s.settings;
        switch (harness) {
            case "claude-code":
                return [claude.displayName, claude.binaryPath, claude.configDir, claude.env].join("\0");
            case "codex":
                return [codex.displayName, codex.binaryPath, codex.homePath, codex.env].join("\0");
            case "opencode":
                return [opencode.displayName, opencode.binaryPath, opencode.env].join("\0");
            default:
                return "";
        }
    });
}

/** Re-reads the CLI's status (version, account) and the catalogs when a field they depend on changes. */
function useReprobe(harness: HarnessId) {
    const key = useRuntimeKey(harness);
    const first = useRef(true);
    useEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }
        const timer = window.setTimeout(() => {
            void refreshCatalogs();
            void refreshProvider(harness, { force: true });
        }, 300);
        return () => window.clearTimeout(timer);
    }, [harness, key]);
}

type TextSetting = { value: string; set: (value: string) => void; modified: boolean; reset: () => void };

function TextRow({
    label,
    description,
    keywords,
    setting,
    placeholder,
    mono
}: {
    label: string;
    description: string;
    keywords: string;
    setting: TextSetting;
    placeholder: string;
    mono?: boolean;
}) {
    return (
        <SettingRow
            label={label}
            description={description}
            keywords={keywords}
            setting={setting}
            controlClassName="w-56"
            control={
                <DraftInput
                    value={setting.value}
                    onCommit={setting.set}
                    placeholder={placeholder}
                    aria-label={label}
                    className={mono ? "font-mono" : undefined}
                />
            }
        />
    );
}

function DisplayNameRow({ setting, fallback }: { setting: TextSetting; fallback: string }) {
    return (
        <TextRow
            label="Display name"
            description="What pickers and the sidebar call it"
            keywords="provider name label rename display"
            setting={setting}
            placeholder={fallback}
        />
    );
}

function BinaryRow({ setting, cli }: { setting: TextSetting; cli: string }) {
    return (
        <TextRow
            label="Binary path"
            description={`The ${cli} to run. Empty finds it on PATH`}
            keywords="binary path executable cli location install which"
            setting={setting}
            placeholder={cli}
            mono
        />
    );
}

function LaunchArgsRow({ setting, what }: { setting: TextSetting; what: string }) {
    return (
        <TextRow
            label="Launch arguments"
            description={`Added to ${what} when a session starts`}
            keywords="launch arguments args flags command line options"
            setting={setting}
            placeholder="e.g. --verbose"
            mono
        />
    );
}

/** `NAME=value` per line, edited in a box and saved when it loses focus. */
function EnvRow({ setting, cli }: { setting: TextSetting; cli: string }) {
    const [draft, setDraft] = useState(setting.value);
    useEffect(() => setDraft(setting.value), [setting.value]);
    const commit = () => {
        const next = draft.replace(/\s+$/, "");
        if (next !== setting.value) setting.set(next);
    };
    return (
        <SettingRow
            label="Environment variables"
            description={`NAME=value per line, set on every ${cli} process. Stored as plain text`}
            keywords="environment variables env api key base url router proxy token"
            setting={setting}
            controlClassName="w-56"
            control={
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Escape" && draft !== setting.value) {
                            e.preventDefault();
                            e.stopPropagation();
                            setDraft(setting.value);
                        }
                    }}
                    rows={Math.min(Math.max(draft.split("\n").length, 2), 8)}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={"ANTHROPIC_BASE_URL=…"}
                    aria-label="Environment variables"
                    className={cn(
                        "w-full resize-none rounded-md border border-dark-500 bg-dark-700 px-2 py-1",
                        "font-mono text-xs leading-4 text-dark-50 outline-none placeholder:text-dark-300",
                        "transition-[border-color] hover:border-dark-400 focus:border-dark-400"
                    )}
                />
            }
        />
    );
}

const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;

/** Typed tokens: `300000`, `300,000`, `300k`, `1m`; null when empty, undefined when not a number. */
function parseTokens(text: string): number | null | undefined {
    const raw = text.trim().toLowerCase().replace(/[,_\s]/g, "");
    if (!raw) return null;
    const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(raw);
    if (!match) return undefined;
    const scale = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
    return Math.round(Number(match[1]) * scale);
}

const IDLE_LABELS: Record<IdleCompaction, string> = {
    onReturn: "When you return",
    beforeCacheExpires: "Before the cache expires",
    off: "Never"
};

const IDLE_DESCRIPTIONS: Record<IdleCompaction, string> = {
    onReturn: "Over 200k tokens and back after the prompt cache expired: compact first",
    beforeCacheExpires: "Over 200k tokens: compact just before the prompt cache expires (while Hive is open)",
    off: "Never compact idle chats; Claude still compacts when full"
};

function IdleMenu({ value, onChange }: { value: IdleCompaction; onChange: (v: IdleCompaction) => void }) {
    return (
        <Menu>
            <Menu.Trigger
                aria-label="Compact idle chats"
                className={cn(
                    "flex h-6 w-full min-w-0 items-center justify-between gap-1 rounded-md px-2 text-xs outline-none",
                    "border border-dark-500 bg-dark-700 text-dark-50",
                    "transition-[background-color,border-color,color] hover:border-dark-400",
                    "focus-visible:border-dark-400 data-[popup-open]:border-dark-400"
                )}
            >
                <span className="min-w-0 truncate">{IDLE_LABELS[value]}</span>
                <CaretDownIcon className="size-3 shrink-0 text-dark-200" />
            </Menu.Trigger>
            <Menu.Content side="bottom" align="end" sideOffset={6} className="w-(--anchor-width) min-w-0">
                {(Object.keys(IDLE_LABELS) as IdleCompaction[]).map((mode) => (
                    <Menu.Item key={mode} onClick={() => onChange(mode)}>
                        <span className="flex-1">{IDLE_LABELS[mode]}</span>
                        {mode === value && <CheckIcon className="size-3" weight="bold" />}
                    </Menu.Item>
                ))}
            </Menu.Content>
        </Menu>
    );
}

function ClaudeRuntime() {
    const displayName = useSetting("claude", "displayName");
    const binary = useSetting("claude", "binaryPath");
    const configDir = useSetting("claude", "configDir");
    const compactWindow = useSetting("claude", "autoCompactWindow");
    const idle = useSetting("claude", "idleCompaction");
    const args = useSetting("claude", "launchArgs");
    const env = useSetting("claude", "env");
    const [invalid, setInvalid] = useState(false);

    const commitWindow = (text: string) => {
        const tokens = parseTokens(text);
        setInvalid(tokens === undefined);
        if (tokens === undefined) return;
        compactWindow.set(tokens === null ? null : Math.min(Math.max(tokens, MIN_WINDOW), MAX_WINDOW));
    };

    return (
        <RuntimeGroup>
            <DisplayNameRow setting={displayName} fallback="Claude Code" />
            <BinaryRow setting={binary} cli="claude" />
            <TextRow
                label="CLAUDE_CONFIG_DIR path"
                description="Another account's config folder. Sign in again after changing it"
                keywords="claude config dir directory home account profile separate"
                setting={configDir}
                placeholder="~/.claude"
                mono
            />
            <SettingRow
                label="Auto-compact after"
                description={
                    invalid
                        ? "Enter tokens, like 300000 or 300k"
                        : "100k to 1M tokens; it compacts about 33k sooner. Empty: Claude's default"
                }
                keywords="claude compact compaction auto context window tokens threshold summarize"
                setting={compactWindow}
                controlClassName="w-56"
                control={
                    <DraftInput
                        value={compactWindow.value == null ? "" : String(compactWindow.value)}
                        onCommit={commitWindow}
                        placeholder="e.g. 300000"
                        inputMode="numeric"
                        invalid={invalid}
                        aria-label="Auto-compact after, in tokens"
                    />
                }
            />
            <SettingRow
                label="Compact idle chats"
                description={IDLE_DESCRIPTIONS[idle.value]}
                keywords="claude compact compaction idle stale cache prompt cache expired resume return"
                setting={idle}
                controlClassName="w-56"
                control={<IdleMenu value={idle.value} onChange={idle.set} />}
            />
            <LaunchArgsRow setting={args} what="claude" />
            <EnvRow setting={env} cli="claude" />
        </RuntimeGroup>
    );
}

function CodexRuntime() {
    const displayName = useSetting("codex", "displayName");
    const binary = useSetting("codex", "binaryPath");
    const home = useSetting("codex", "homePath");
    const args = useSetting("codex", "launchArgs");
    const env = useSetting("codex", "env");
    return (
        <RuntimeGroup>
            <DisplayNameRow setting={displayName} fallback="Codex" />
            <BinaryRow setting={binary} cli="codex" />
            <TextRow
                label="CODEX_HOME path"
                description="Another account's home and config folder"
                keywords="codex home dir directory config account profile separate"
                setting={home}
                placeholder="~/.codex"
                mono
            />
            <LaunchArgsRow setting={args} what="codex app-server" />
            <EnvRow setting={env} cli="codex" />
        </RuntimeGroup>
    );
}

function OpencodeRuntime() {
    const displayName = useSetting("opencode", "displayName");
    const binary = useSetting("opencode", "binaryPath");
    const args = useSetting("opencode", "launchArgs");
    const env = useSetting("opencode", "env");
    return (
        <RuntimeGroup>
            <DisplayNameRow setting={displayName} fallback="OpenCode" />
            <BinaryRow setting={binary} cli="opencode" />
            <LaunchArgsRow setting={args} what="opencode serve" />
            <EnvRow setting={env} cli="opencode" />
        </RuntimeGroup>
    );
}

function RuntimeGroup({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dark-100">Runtime</span>
            <div className="flex flex-col rounded-md border border-dark-600 [&:not(:has([data-setting-row]))]:hidden">
                {children}
            </div>
        </div>
    );
}
