import { useState } from "react";
import { FolderOpenIcon } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/lib/platform";
import { Button, Input, NumberField } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

export function ClaudePage() {
    return (
        <>
            <SessionsSection />
            <BinarySection />
        </>
    );
}

function SessionsSection() {
    const idle = useSetting("chat", "idleTimeoutMinutes");

    return (
        <SettingsSection title="Sessions">
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

function BinarySection() {
    const binaryPath = useSetting("claude", "binaryPath");

    return (
        <SettingsSection title="Executable">
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
                className="font-mono text-xs"
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
