export {
    activeFolder,
    closeTab,
    discardTab,
    openDiffTab,
    openFileTab,
    openTerminalTab
} from "./actions";
export { NEW_TABS, type NewTab } from "./kinds";
export { RightSidebar } from "./RightSidebar";
export { useRightbarStore, type RightTab, type TabContent } from "./store";
export { TabStrip } from "./TabStrip";
