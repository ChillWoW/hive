import { codex } from "@/features/codex/store";
import { SettingsSection } from "../SettingsSection";
import { AccountSection, LocationRow, UsageSection } from "./ProviderSections";

/**
 * Codex's settings under its header in Settings › Providers: its ChatGPT
 * account and plan usage, and where its CLI is.
 */
export function CodexSettings() {
    return (
        <>
            <AccountSection provider={codex} label="ChatGPT account" />
            <UsageSection provider={codex} signedOutHint="Shown for a ChatGPT login" dock="codex" />
            <SettingsSection title="Installation">
                <LocationRow provider={codex} />
            </SettingsSection>
        </>
    );
}
