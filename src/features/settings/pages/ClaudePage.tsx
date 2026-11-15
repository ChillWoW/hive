import { useState } from "react";
import { FolderOpenIcon } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/lib/platform";
import { Input, NumberInput } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

export function ClaudePage() {
    return (
        <>
            <BinarySection />
            <SessionsSection />
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
                controlClassName="w-28"
                control={
                    <NumberInput
                        size="sm"
                        value={idle.value}
                        min={1}
                        max={1440}
                        decimalPlaces={0}
                        suffix="min"
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
        <Input
            size="sm"
            value={draft ?? value}
            placeholder="Auto-detect"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setDraft(null);
            }}
            className="font-mono"
            rightIcon={
                isTauri && (
                    <button
                        type="button"
                        aria-label="Browse"
                        onClick={() => void browse()}
                        className="inline-flex size-4 items-center justify-center hover:text-text"
                    >
                        <FolderOpenIcon className="size-3.5" />
                    </button>
                )
            }
        />
    );
}
