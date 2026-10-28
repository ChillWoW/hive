import type { ComponentType } from "react";
import { InfoIcon, type Icon } from "@phosphor-icons/react";
import type { SettingsPageId } from "../store";
import { AboutPage } from "./AboutPage";

export type SettingsPage = {
    id: SettingsPageId;
    label: string;
    icon: Icon;
    Component: ComponentType;
};

/** Nav order. A new page: add its id to `SettingsPageId` and a row here. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
    {
        id: "about",
        label: "About",
        icon: InfoIcon,
        Component: AboutPage
    }
];

export function getSettingsPage(id: SettingsPageId): SettingsPage {
    return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0]!;
}
