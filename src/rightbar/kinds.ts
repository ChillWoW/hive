import type { Icon } from "@phosphor-icons/react";

/** Something the "+" menu opens in a new tab. */
export type NewTab = { label: string; icon: Icon; open: () => void };

/**
 * What the "+" menu offers, in its order; it's hidden while there's nothing.
 * Files open from the file panel's tree instead.
 */
export const NEW_TABS: readonly NewTab[] = [];
