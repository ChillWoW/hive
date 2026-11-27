import { antigravity } from "@/features/antigravity/store";
import { SettingsSection } from "../SettingsSection";
import { AccountSection, LocationRow, UsageSection } from "./ProviderSections";

/**
 * Antigravity's settings under its header in Settings › Providers: its
 * Google account and model quota, and where its CLI is.
 */
export function AntigravitySettings() {
    return (
        <>
            <AccountSection provider={antigravity} label="Google account" />
            <UsageSection provider={antigravity} signedOutHint="Shown for a Google account login" dock="antigravity" />
            <SettingsSection title="Installation">
                <LocationRow provider={antigravity} />
            </SettingsSection>
        </>
    );
}
