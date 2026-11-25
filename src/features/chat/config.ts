import type { Catalog, ChatConfig } from "@/proto";
import { chatsApi } from "@/features/chats/api";
import { useActiveChat } from "@/features/chats/store";
import { useComposerStore } from "@/features/composer/store";
import { defaultConfig, fitConfig, useCatalog } from "@/features/models";
import { useCatalogStore } from "@/features/models/catalog";
import { useSettingsStore } from "@/features/settings";
import type { ChatSettings } from "@/features/settings/types";

/** The new chat's config: the one picked last on this device, else Settings' defaults. */
function newConfig(picked: ChatConfig | null, settings: ChatSettings, catalog: Catalog | null) {
    const config = picked ?? defaultConfig(settings);
    return catalog ? fitConfig(catalog, config) : config;
}

/** What the next new chat is created with, outside React. */
export function newChatConfig(): ChatConfig {
    return newConfig(
        useComposerStore.getState().newChatConfig,
        useSettingsStore.getState().settings.chat,
        useCatalogStore.getState().catalog
    );
}

/**
 * What the composer's model picker shows and edits: the open chat's config
 * (saved on the chat; its run picks it up from the next prompt), or in the
 * new-chat view the next chat's.
 */
export function useChatConfig(): [ChatConfig, (config: ChatConfig) => void] {
    const chat = useActiveChat();
    const catalog = useCatalog();
    const picked = useComposerStore((s) => s.newChatConfig);
    const settings = useSettingsStore((s) => s.settings.chat);
    if (!chat) {
        const set = (config: ChatConfig) => useComposerStore.getState().setNewChatConfig(config);
        return [newConfig(picked, settings, catalog), set];
    }
    const config = catalog ? fitConfig(catalog, chat.config) : chat.config;
    const set = (config: ChatConfig) =>
        void chatsApi.setConfig(chat.id, config).catch((error: unknown) => console.warn("[chat]", error));
    return [config, set];
}
