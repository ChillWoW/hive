/** The card's inset from the chat pane's top and right edges. */
export const DETAILS_CARD_GAP = 12;
export const DETAILS_CARD_WIDTH = 280;
/** Room kept between the card and the transcript's column. */
const CLEARANCE = 32;
/** The column's side padding (`px-6`) and widest (`max-w-3xl`). */
const PADDING = 24;
const LANE_MAX = 768;
/** Narrower than this and the card stays hidden rather than squeeze the chat. */
const MIN_LANE = 480;

export type DetailsLayout = {
    /** The card fits beside the column. */
    inline: boolean;
    /** How far the column moves left of centre to clear the card. */
    shift: number;
    /** The column's width while the card is up. */
    lane: number;
};

/**
 * Where the transcript's column goes with the card floating at the pane's
 * top right: centred while it clears the card, else slid left, then
 * narrowed, down to `MIN_LANE`.
 */
export function detailsLayout(width: number, open: boolean): DetailsLayout {
    const centred = Math.max(0, Math.min(LANE_MAX, width - PADDING * 2));
    const limit = width - DETAILS_CARD_GAP - DETAILS_CARD_WIDTH - CLEARANCE;
    if (!open || limit - PADDING < MIN_LANE) return { inline: false, shift: 0, lane: centred };
    const lane = Math.min(centred, limit - PADDING);
    const centredLeft = (width - lane) / 2;
    const left = Math.max(PADDING, Math.min(centredLeft, limit - lane));
    return { inline: true, shift: centredLeft - left, lane };
}
