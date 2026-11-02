import { CaretDownIcon } from "@phosphor-icons/react";
import { DetailsItemsMenuItems } from "@/chat/details/DetailsItemsMenu";
import {
    DETAILS_ITEMS,
    isDefaultDetailsItems,
    resetDetailsItems,
    useDetailsItems
} from "@/chat/details/items";
import { cn } from "@/lib/cn";
import { Menu } from "@/ui";
import { SettingRow } from "../SettingsSection";

/** Settings › Chats: which rows the chat details card shows, the card's own menu. */
export function ChatDetailsRow() {
    const shown = useDetailsItems();
    const count = DETAILS_ITEMS.filter(({ id }) => shown[id]).length;
    return (
        <SettingRow
            label="Rows shown"
            description="What the details card in a chat lists. Right-click the card for the same"
            keywords="chat details card panel rows items show hide project editor terminal changes sync github cost"
            setting={{ modified: !isDefaultDetailsItems(shown), reset: resetDetailsItems }}
            control={
                <Menu>
                    <Menu.Trigger
                        aria-label="Rows shown"
                        className={cn(
                            "flex h-6 w-full min-w-0 items-center justify-between gap-1 rounded-md px-2 text-xs outline-none",
                            "border border-dark-500 bg-dark-700 text-dark-50",
                            "transition-[background-color,border-color,color] hover:border-dark-400",
                            "focus-visible:border-dark-400 data-[popup-open]:border-dark-400"
                        )}
                    >
                        <span className="min-w-0 truncate">
                            {count === DETAILS_ITEMS.length ? "All" : `${count} of ${DETAILS_ITEMS.length}`}
                        </span>
                        <CaretDownIcon className="size-3 shrink-0 text-dark-200" />
                    </Menu.Trigger>
                    <Menu.Content side="bottom" align="end" sideOffset={6} className="w-56 min-w-0">
                        <DetailsItemsMenuItems />
                    </Menu.Content>
                </Menu>
            }
        />
    );
}
