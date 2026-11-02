import { useId } from "react";

type DetailsCardIconProps = {
    weight?: "regular" | "fill";
    className?: string;
};

/** The small card, in the window's top right. */
const CARD = { x: 128, y: 76, width: 60, height: 52, rx: 10 };
/** Space kept around the card when the window is filled. */
const GAP = 14;

/**
 * The chat details toggle in Phosphor's style (256 grid, 16 stroke): a window
 * with a card floating in its top right, as the details card floats in the
 * thread. `fill` fills the window, the card cut out of it with a gap.
 */
export function DetailsCardIcon({ weight = "regular", className }: DetailsCardIconProps) {
    const mask = useId();
    const filled = weight === "fill";
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 256 256"
            fill="none"
            stroke="currentColor"
            strokeWidth={16}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden
        >
            {filled && (
                <mask id={mask}>
                    <rect x={0} y={0} width={256} height={256} fill="white" stroke="none" />
                    <rect
                        x={CARD.x - GAP}
                        y={CARD.y - GAP}
                        width={CARD.width + GAP * 2}
                        height={CARD.height + GAP * 2}
                        rx={CARD.rx + GAP}
                        fill="black"
                        stroke="none"
                    />
                </mask>
            )}
            <rect
                x={32}
                y={40}
                width={192}
                height={176}
                rx={28}
                fill={filled ? "currentColor" : "none"}
                mask={filled ? `url(#${mask})` : undefined}
            />
            <rect {...CARD} fill="currentColor" stroke="none" />
        </svg>
    );
}
