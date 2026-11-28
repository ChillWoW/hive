import { useChatsStore } from "@/features/chats";
import { addDraftAttachments, composer } from "@/features/composer/store";
import { elementMention } from "@/features/composer/tags";
import { toast } from "@/ui";
import { browserApi } from "./api";
import { useBrowserStore } from "./store";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The chat whose prompt takes what's sent from a tab: the open one, or the new-chat view (null). */
const targetChat = () => useChatsStore.getState().activeChatId;

/** Attaches a picture of tab `id`'s page to the open chat's unsent prompt. */
export async function attachScreenshot(id: string) {
    try {
        const attachment = await browserApi.capture(id);
        addDraftAttachments(targetChat(), [attachment]);
        composer.focus();
    } catch (error) {
        toast.error({ title: "Couldn't take a screenshot", description: message(error) });
    }
}

/**
 * Lets the user click an element in tab `id`'s page, then puts it in the
 * open chat's unsent prompt: a tag in the text (its selector, what it is,
 * its page), its picture attached. Called again while picking, it backs out.
 */
export async function pickElement(id: string) {
    if (useBrowserStore.getState().picking === id) {
        void browserApi.cancelPick(id).catch(() => {});
        return;
    }
    useBrowserStore.setState({ picking: id });
    try {
        const picked = await browserApi.pick(id);
        if (!picked) return;
        const chatId = targetChat();
        if (picked.attachment) addDraftAttachments(chatId, [picked.attachment]);
        const draft = composer.draft(chatId);
        const gap = draft && !/\s$/.test(draft) ? " " : "";
        const mention = elementMention({
            selector: picked.selector,
            tag: picked.tag,
            text: picked.text.slice(0, 80),
            page: picked.url
        });
        composer.setDraft(chatId, `${draft}${gap}${mention} `);
        composer.focus();
    } catch (error) {
        toast.error({ title: "Couldn't pick an element", description: message(error) });
    } finally {
        if (useBrowserStore.getState().picking === id) useBrowserStore.setState({ picking: null });
    }
}

/** Loads what was typed in tab `id`: a URL, a host, or a search. */
export function navigate(id: string, text: string) {
    browserApi.navigate(id, text).catch((error) => {
        toast.error({ title: "Couldn't open that", description: message(error) });
    });
}
