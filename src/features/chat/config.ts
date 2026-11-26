import type { ChatConfig } from "@/proto";
import { chatsApi } from "@/features/chats/api";
import { useActiveChat } from "@/features/chats/store";
import { useComposerStore } from "@/features/composer/store";
import { defaultConfig, fitToCatalogs, useCatalogs } from "@/features/models";
import { type Catalogs, useCatalogStore } from "@/features/models/catalog";
import { useSettingsStore } from "@/features/settings";
import type { Settings } from "@/features/settings/types";

/** The new chat's config: the one picked last on this device, else Settings' defaults. */
function newConfig(picked: ChatConfig | null, settings: Settings, catalogs: Catalogs) {
    const fallback = defaultConfig(settings.chat, settings.claude.defaultAccess);
    const config = picked ? { ...fallback, ...picked } : fallback;
    return fitToCatalogs(catalogs, config);
}

/** What the next new chat is created with, outside React. */
export function newChatConfig(): ChatConfig {
    return newConfig(
        useComposerStore.getState().newChatConfig,
        useSettingsStore.getState().settings,
        useCatalogStore.getState().catalogs
    );
}

/**
 * What the composer's pickers show and edit: the open chat's config (saved
 * on the chat; model and effort apply from its next prompt, access and plan
 * mode at once), or in the new-chat view the next chat's.
 */
export function useChatConfig(): [ChatConfig, (config: ChatConfig) => void] {
    const chat = useActiveChat();
    const catalogs = useCatalogs();
    const picked = useComposerStore((s) => s.newChatConfig);
    const settings = useSettingsStore((s) => s.settings);
    if (!chat) {
        const set = (config: ChatConfig) => useComposerStore.getState().setNewChatConfig(config);
        return [newConfig(picked, settings, catalogs), set];
    }
    const config = fitToCatalogs(catalogs, chat.config);
    const set = (config: ChatConfig) =>
        void chatsApi.setConfig(chat.id, config).catch((error: unknown) => console.warn("[chat]", error));
    return [config, set];
}
