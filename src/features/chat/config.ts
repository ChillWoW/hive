import type { Catalog, ChatConfig } from "@/proto";
import { chatsApi } from "@/features/chats/api";
import { useActiveChat } from "@/features/chats/store";
import { useComposerStore } from "@/features/composer/store";
import { defaultConfig, fitConfig, useCatalog } from "@/features/models";
import { useCatalogStore } from "@/features/models/catalog";
import { useSettingsStore } from "@/features/settings";
import type { Settings } from "@/features/settings/types";

/** The new chat's config: the one picked last on this device, else Settings' defaults. */
function newConfig(picked: ChatConfig | null, settings: Settings, catalog: Catalog | null) {
    const fallback = defaultConfig(settings.chat, settings.claude.defaultAccess);
    const config = picked ? { ...fallback, ...picked } : fallback;
    return catalog ? fitConfig(catalog, config) : config;
}

/** What the next new chat is created with, outside React. */
export function newChatConfig(): ChatConfig {
    return newConfig(
        useComposerStore.getState().newChatConfig,
        useSettingsStore.getState().settings,
        useCatalogStore.getState().catalog
    );
}

/**
 * What the composer's pickers show and edit: the open chat's config (saved
 * on the chat; model and effort apply from its next prompt, access and plan
 * mode at once), or in the new-chat view the next chat's.
 */
export function useChatConfig(): [ChatConfig, (config: ChatConfig) => void] {
    const chat = useActiveChat();
    const catalog = useCatalog();
    const picked = useComposerStore((s) => s.newChatConfig);
    const settings = useSettingsStore((s) => s.settings);
    if (!chat) {
        const set = (config: ChatConfig) => useComposerStore.getState().setNewChatConfig(config);
        return [newConfig(picked, settings, catalog), set];
    }
    const config = catalog ? fitConfig(catalog, chat.config) : chat.config;
    const set = (config: ChatConfig) =>
        void chatsApi.setConfig(chat.id, config).catch((error: unknown) => console.warn("[chat]", error));
    return [config, set];
}
