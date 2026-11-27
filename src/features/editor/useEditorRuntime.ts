import { useEffect } from "react";
import { useChatsStore, workDir } from "@/features/chats";
import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { onWindowFocus } from "@/lib/windowFocus";
import { blockClose, checkAllOnDisk, checkDisk, dropDoc, getDoc, save, useDocsStore } from "./documents";

/**
 * File tabs' editors: a tab with unsaved changes saves before it closes (a
 * failed save keeps it open, saying so), its dirty dot follows its doc, a
 * closed tab's doc is dropped, and open files are read again when they may
 * have changed on disk: the window regaining focus, an agent's turn ending
 * in their folder, their tab being shown. Mount once, at the root.
 */
export function useEditorRuntime() {
    useEffect(() => {
        panelTabs.setCloseGuard((tab) => {
            if (!getDoc(tab.id)?.dirty) return false;
            void save(tab.id).then((saved) => {
                if (saved) {
                    panelTabs.close(tab.id);
                } else {
                    blockClose(tab.id);
                    panelTabs.select(tab.id);
                }
            });
            return true;
        });

        const stopDocs = useDocsStore.subscribe((state, previous) => {
            if (state.docs === previous.docs) return;
            for (const tab of usePanelTabsStore.getState().tabs) {
                const dirty = state.docs[tab.id]?.dirty;
                if (dirty !== undefined && dirty !== !!tab.dirty) panelTabs.update(tab.id, { dirty });
            }
        });

        const stopTabs = usePanelTabsStore.subscribe((state, previous) => {
            if (state.tabs !== previous.tabs) {
                const open = new Set(state.tabs.map((t) => t.id));
                for (const id of Object.keys(useDocsStore.getState().docs)) if (!open.has(id)) dropDoc(id);
            }
            if (state.activeId && state.activeId !== previous.activeId) void checkDisk(state.activeId);
        });

        const stopFocus = onWindowFocus(() => checkAllOnDisk());

        const stopChats = useChatsStore.subscribe((state, previous) => {
            for (const chat of state.chats) {
                const was = previous.sessions[chat.id]?.working;
                if (was && !state.sessions[chat.id]?.working) checkAllOnDisk(workDir(chat));
            }
        });

        return () => {
            panelTabs.setCloseGuard(null);
            stopDocs();
            stopTabs();
            stopFocus();
            stopChats();
        };
    }, []);
}
