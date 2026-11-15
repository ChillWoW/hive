import type { ComponentType } from "react";
import {
    ChatsCircleIcon,
    InfoIcon,
    KeyboardIcon,
    PaletteIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import type { SettingsPageId } from "../store";
import { AboutPage } from "./AboutPage";
import { AppearancePage } from "./AppearancePage";
import { ChatsPage } from "./ChatsPage";
import { ClaudePage } from "./ClaudePage";
import { KeyboardPage } from "./KeyboardPage";

export type SettingsPage = {
    id: SettingsPageId;
    label: string;
    icon: Icon;
    Component: ComponentType;
};

/** Nav order. A new page: add its id to `SettingsPageId` and a row here. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
    { id: "appearance", label: "Appearance", icon: PaletteIcon, Component: AppearancePage },
    { id: "keyboard", label: "Keyboard", icon: KeyboardIcon, Component: KeyboardPage },
    { id: "chats", label: "Chats", icon: ChatsCircleIcon, Component: ChatsPage },
    { id: "claude", label: "Claude Code", icon: TerminalWindowIcon, Component: ClaudePage },
    { id: "about", label: "About", icon: InfoIcon, Component: AboutPage }
];

export function getSettingsPage(id: SettingsPageId): SettingsPage {
    return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0]!;
}
