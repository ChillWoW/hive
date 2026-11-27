import { open } from "@tauri-apps/plugin-dialog";
import { isMac, isTauri, platform } from "@/lib/platform";
import { NumberField, SegmentedControl, Select } from "@/ui";
import { CommitInput, CommitTextarea } from "../CommitFields";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";
import type { TerminalCloseOnExit, TerminalCursor, TerminalStartIn } from "../types";

const START_IN: { value: TerminalStartIn; label: string }[] = [
    { value: "workspace", label: "Chat folder" },
    { value: "home", label: "Home folder" }
];

const CLOSE_ON_EXIT: { value: TerminalCloseOnExit; label: string }[] = [
    { value: "clean", label: "After a clean exit" },
    { value: "always", label: "Always" },
    { value: "never", label: "Never" }
];

/** What an empty shell setting runs, as the placeholder says it. */
const DEFAULT_SHELL = platform === "windows" ? "PowerShell" : "Login shell ($SHELL)";
const DEFAULT_ARGS = isMac ? "-l" : "None";

/** Terminal tabs in the tabs panel: the shell they run, how they look, and how they behave. */
export function TerminalPage() {
    return (
        <>
            <ShellSection />
            <TextSection />
            <CursorSection />
            <BehaviorSection />
        </>
    );
}

function ShellSection() {
    const shell = useSetting("terminal", "shell");
    const args = useSetting("terminal", "shellArgs");
    const env = useSetting("terminal", "env");
    const startIn = useSetting("terminal", "startIn");
    const closeOnExit = useSetting("terminal", "closeOnExit");

    const browse = async () => {
        const picked = await open({ directory: false, title: "Choose a shell" });
        if (typeof picked === "string") shell.set(picked);
    };

    return (
        <SettingsSection title="Shell">
            <SettingRow
                label="Shell"
                description="What new terminals run; empty uses your login shell"
                keywords="terminal shell program zsh bash fish pwsh powershell nu path executable"
                setting={shell}
                controlClassName="w-64"
                control={
                    <CommitInput
                        value={shell.value}
                        placeholder={DEFAULT_SHELL}
                        label="Shell"
                        onCommit={shell.set}
                        onBrowse={isTauri ? () => void browse() : undefined}
                        browseLabel="Choose a shell"
                    />
                }
            />
            <SettingRow
                label="Arguments"
                description="Passed to the shell; empty uses the usual ones"
                keywords="terminal shell arguments args flags login interactive"
                setting={args}
                controlClassName="w-64"
                control={
                    <CommitInput
                        value={args.value}
                        placeholder={DEFAULT_ARGS}
                        label="Shell arguments"
                        onCommit={args.set}
                    />
                }
            />
            <SettingRow
                label="Environment"
                description="Extra variables, one KEY=value per line"
                keywords="terminal environment variables env path"
                setting={env}
                controlClassName="w-64"
                control={
                    <CommitTextarea
                        value={env.value}
                        placeholder="EDITOR=nvim"
                        label="Terminal environment"
                        onCommit={env.set}
                    />
                }
            />
            <SettingRow
                label="Start in"
                description="The open chat's folder (its worktree, if any) or your home folder"
                keywords="terminal start directory folder cwd working home workspace worktree"
                setting={startIn}
                control={
                    <Select
                        items={START_IN}
                        value={startIn.value}
                        onValueChange={(next: TerminalStartIn | null) => next && startIn.set(next)}
                    >
                        <Select.Trigger aria-label="Start in">
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {START_IN.map((option) => (
                                <Select.Item key={option.value} value={option.value}>
                                    {option.label}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                }
            />
            <SettingRow
                label="Close the tab"
                description="When the shell exits; a clean exit is code 0, like typing exit"
                keywords="terminal close exit tab quit shell ended code"
                setting={closeOnExit}
                control={
                    <Select
                        items={CLOSE_ON_EXIT}
                        value={closeOnExit.value}
                        onValueChange={(next: TerminalCloseOnExit | null) => next && closeOnExit.set(next)}
                    >
                        <Select.Trigger aria-label="Close the tab">
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {CLOSE_ON_EXIT.map((option) => (
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

function TextSection() {
    const fontSize = useSetting("terminal", "fontSize");
    const lineHeight = useSetting("terminal", "lineHeight");

    return (
        <SettingsSection title="Text">
            <SettingRow
                label="Font size"
                description="In pixels; the font is the code font from Appearance"
                keywords="terminal font size text zoom px"
                setting={fontSize}
                controlClassName="w-32"
                control={
                    <NumberField
                        aria-label="Terminal font size in pixels"
                        value={fontSize.value}
                        min={8}
                        max={32}
                        step={1}
                        format={{ maximumFractionDigits: 0 }}
                        onValueChange={(value) => value != null && fontSize.set(value)}
                    />
                }
            />
            <SettingRow
                label="Line height"
                description="Space per line, as a multiple of the font size"
                keywords="terminal line height spacing leading"
                setting={lineHeight}
                controlClassName="w-32"
                control={
                    <NumberField
                        aria-label="Terminal line height"
                        value={lineHeight.value}
                        min={1}
                        max={2}
                        step={0.05}
                        format={{ minimumFractionDigits: 1, maximumFractionDigits: 2 }}
                        onValueChange={(value) => value != null && lineHeight.set(value)}
                    />
                }
            />
        </SettingsSection>
    );
}

function CursorSection() {
    const style = useSetting("terminal", "cursorStyle");
    const blink = useSetting("terminal", "cursorBlink");

    return (
        <SettingsSection title="Cursor">
            <SettingRow
                label="Style"
                keywords="terminal cursor style shape bar block underline caret"
                setting={style}
                controlClassName="w-auto"
                control={
                    <SegmentedControl
                        size="xs"
                        value={style.value}
                        onValueChange={(value) => style.set(value as TerminalCursor)}
                        aria-label="Cursor style"
                    >
                        <SegmentedControl.Item value="bar">Bar</SegmentedControl.Item>
                        <SegmentedControl.Item value="block">Block</SegmentedControl.Item>
                        <SegmentedControl.Item value="underline">Underline</SegmentedControl.Item>
                    </SegmentedControl>
                }
            />
            <SwitchRow
                label="Blink"
                description="The cursor blinks while the terminal has focus"
                keywords="terminal cursor blink blinking flash"
                setting={blink}
                aria-label="Blinking cursor"
            />
        </SettingsSection>
    );
}

function BehaviorSection() {
    const scrollback = useSetting("terminal", "scrollback");
    const copyOnSelect = useSetting("terminal", "copyOnSelect");
    const optionAsMeta = useSetting("terminal", "optionAsMeta");
    const gpu = useSetting("terminal", "gpuAcceleration");

    return (
        <SettingsSection title="Behavior">
            <SettingRow
                label="Scrollback"
                description="Lines kept above the screen"
                keywords="terminal scrollback history buffer lines scroll"
                setting={scrollback}
                controlClassName="w-40"
                control={
                    <NumberField
                        aria-label="Scrollback lines"
                        value={scrollback.value}
                        min={0}
                        max={100000}
                        step={1000}
                        onValueChange={(value) => value != null && scrollback.set(value)}
                    />
                }
            />
            <SwitchRow
                label="Copy on select"
                description="Selecting text copies it to the clipboard"
                keywords="terminal copy select selection clipboard automatic"
                setting={copyOnSelect}
            />
            {isMac && (
                <SwitchRow
                    label="Option as Meta"
                    description="⌥ sends Meta for shell shortcuts instead of typing symbols"
                    keywords="terminal option alt meta key macos emacs readline"
                    setting={optionAsMeta}
                />
            )}
            <SwitchRow
                label="GPU acceleration"
                description="Draw with WebGL; turn off if text renders wrong"
                keywords="terminal gpu webgl renderer acceleration performance canvas dom"
                setting={gpu}
            />
        </SettingsSection>
    );
}
