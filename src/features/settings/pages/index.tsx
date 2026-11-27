import type { ComponentType } from "react";
import {
    ChatsCircleIcon,
    GitForkIcon,
    InfoIcon,
    KeyboardIcon,
    PaletteIcon,
    PlugsConnectedIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import type { SettingsPageId } from "../store";
import { AboutPage } from "./AboutPage";
import { AppearancePage } from "./AppearancePage";
import { ChatsPage } from "./ChatsPage";
import { ProvidersPage } from "./ProvidersPage";
import { KeyboardPage } from "./KeyboardPage";
import { TerminalPage } from "./TerminalPage";
import { WorktreesPage } from "./WorktreesPage";

export type SettingsCategoryId = "interface" | "agents" | "app";

export type SettingsPage = {
    id: SettingsPageId;
    label: string;
    icon: Icon;
    Component: ComponentType;
};

export type SettingsCategory = {
    id: SettingsCategoryId;
    label: string;
    pages: readonly SettingsPage[];
};

/** Nav order. A new page: add its id to `SettingsPageId` and a row under its category. */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
    {
        id: "interface",
        label: "Interface",
        pages: [
            { id: "appearance", label: "Appearance", icon: PaletteIcon, Component: AppearancePage },
            { id: "keyboard", label: "Keyboard", icon: KeyboardIcon, Component: KeyboardPage },
            { id: "terminal", label: "Terminal", icon: TerminalWindowIcon, Component: TerminalPage }
        ]
    },
    {
        id: "agents",
        label: "Agents",
        pages: [
            { id: "chats", label: "Chats", icon: ChatsCircleIcon, Component: ChatsPage },
            { id: "worktrees", label: "Worktrees", icon: GitForkIcon, Component: WorktreesPage },
            {
                id: "providers",
                label: "Providers",
                icon: PlugsConnectedIcon,
                Component: ProvidersPage
            }
        ]
    },
    {
        id: "app",
        label: "App",
        pages: [{ id: "about", label: "About", icon: InfoIcon, Component: AboutPage }]
    }
];

export const SETTINGS_PAGES: readonly SettingsPage[] = SETTINGS_CATEGORIES.flatMap(
    (category) => category.pages
);

export function getSettingsPage(id: SettingsPageId): SettingsPage {
    return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0]!;
}
