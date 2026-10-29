type FolderTreeIconProps = {
    weight?: "regular" | "fill";
    className?: string;
};

/** Folder outline at the given top; the body sits 12 below the tab. */
const folder = (y: number) =>
    `M132,${y}h28l12,12h40a8,8,0,0,1,8,8v36a8,8,0,0,1-8,8H132a8,8,0,0,1-8-8V${y + 8}a8,8,0,0,1,8-8Z`;

/**
 * A file tree in Phosphor's style (256 grid, 16 stroke): a rail on the left
 * branching to two folders, as in zeron's titlebar files toggle. `fill`
 * fills the folders, like Phosphor's fill weight.
 */
export function FolderTreeIcon({
    weight = "regular",
    className
}: FolderTreeIconProps) {
    const fill = weight === "fill" ? "currentColor" : "none";
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
            <path d="M36,32V178a16,16,0,0,0,16,16H92" />
            <path d="M36,58a16,16,0,0,0,16,16H92" />
            <path d={folder(36)} fill={fill} />
            <path d={folder(156)} fill={fill} />
        </svg>
    );
}
