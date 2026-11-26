import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
    ArrowSquareOutIcon,
    CaretLeftIcon,
    CaretRightIcon,
    MagnifyingGlassMinusIcon,
    MagnifyingGlassPlusIcon,
    XIcon
} from "@phosphor-icons/react";
import type { Attachment } from "@/proto";
import { cn } from "@/lib/cn";
import { openFile } from "@/lib/files";
import { useResizeObserver } from "@/lib/useResizeObserver";
import { IconButton, iconButtonClassName, toast, useLastNonNull } from "@/ui";
import { formatBytes, useAttachmentUrl } from "./attachments";

/** Zoom bounds, relative to the image fitted to the window. */
const MIN_SCALE = 1;
const MAX_SCALE = 10;
/** How much one +/- (button or key) zooms. */
const STEP = 1.5;

/**
 * Full-window lightbox over `images`, showing `images[index]`; null closes it.
 * Wheel or +/- zooms, drag pans, a click toggles zoom, ←/→ steps through.
 */
export function ImageViewer({
    images,
    index,
    onIndexChange
}: {
    images: Attachment[];
    index: number | null;
    onIndexChange: (index: number | null) => void;
}) {
    // Keep the last image up while the viewer animates out.
    const shown = useLastNonNull(index);
    const image = shown === null ? undefined : images[Math.min(shown, images.length - 1)];
    const many = images.length > 1;
    const popupRef = useRef<HTMLDivElement>(null);
    const step = (delta: number) => {
        if (index === null || !many) return;
        onIndexChange((index + delta + images.length) % images.length);
    };

    return (
        <DialogPrimitive.Root open={index !== null && !!image} onOpenChange={(open) => !open && onIndexChange(null)}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Backdrop
                    className={cn(
                        "fixed inset-0 bg-black/90 transition-opacity duration-150 ease-out",
                        "data-starting-style:opacity-0 data-ending-style:opacity-0"
                    )}
                />
                <DialogPrimitive.Popup
                    ref={popupRef}
                    initialFocus={popupRef}
                    aria-label={image?.name ?? "Image"}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowLeft") step(-1);
                        else if (e.key === "ArrowRight") step(1);
                        else return;
                        e.preventDefault();
                    }}
                    className={cn(
                        "fixed inset-0 flex flex-col text-text outline-none",
                        "transition-[opacity,scale] duration-150 ease-out",
                        "data-starting-style:scale-[0.98] data-starting-style:opacity-0",
                        "data-ending-style:scale-[0.98] data-ending-style:opacity-0"
                    )}
                >
                    {image && (
                        <ImageView
                            key={image.path}
                            image={image}
                            counter={many && shown !== null ? `${shown + 1} / ${images.length}` : undefined}
                        />
                    )}
                    {many && (
                        <>
                            <NavButton side="left" onClick={() => step(-1)} />
                            <NavButton side="right" onClick={() => step(1)} />
                        </>
                    )}
                </DialogPrimitive.Popup>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
    const Icon = side === "left" ? CaretLeftIcon : CaretRightIcon;
    return (
        <button
            type="button"
            aria-label={side === "left" ? "Previous image" : "Next image"}
            onClick={onClick}
            className={cn(
                "absolute top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full",
                "bg-black/50 text-white/80 transition-colors hover:bg-black/70 hover:text-white",
                side === "left" ? "left-4" : "right-4"
            )}
        >
            <Icon className="size-5" weight="bold" />
        </button>
    );
}

interface View {
    scale: number;
    x: number;
    y: number;
}

/** The chrome sits on the dark backdrop whatever the theme. */
const darkButton = "text-inherit hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white";

const FIT: View = { scale: MIN_SCALE, x: 0, y: 0 };

/** One image with its header; keyed by path, so zoom resets between images. */
function ImageView({ image, counter }: { image: Attachment; counter?: string }) {
    const url = useAttachmentUrl(image);
    const stageRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const [view, setView] = useState<View>(FIT);
    // Ease button/key zooms; follow the wheel and drags directly.
    const [animate, setAnimate] = useState(false);
    const [natural, setNatural] = useState<{ width: number; height: number }>();
    // Fitted width over natural width, for showing zoom as a share of real size.
    const [fit, setFit] = useState(1);
    const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
    const [dragging, setDragging] = useState(false);
    const close = useRef<HTMLButtonElement>(null);
    const zoomed = view.scale > MIN_SCALE;

    // The image is sized by the stage, so track the stage.
    useResizeObserver(stageRef, () => {
        const img = imgRef.current;
        if (img?.naturalWidth) setFit(img.clientWidth / img.naturalWidth);
    });

    /** `next` with its offset kept so the image never leaves an edge gap. */
    const clamp = (next: View): View => {
        const stage = stageRef.current;
        const img = imgRef.current;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale));
        if (!stage || !img || scale === MIN_SCALE) return { scale, x: 0, y: 0 };
        const maxX = Math.max(0, (img.clientWidth * scale - stage.clientWidth) / 2);
        const maxY = Math.max(0, (img.clientHeight * scale - stage.clientHeight) / 2);
        return {
            scale,
            x: Math.min(maxX, Math.max(-maxX, next.x)),
            y: Math.min(maxY, Math.max(-maxY, next.y))
        };
    };

    /** Zooms to `scale`, keeping the point `at` (from the stage's centre) still. */
    const zoomTo = (scale: number, at = { x: 0, y: 0 }, smooth = true) => {
        setAnimate(smooth);
        setView((v) => {
            const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
            const k = s / v.scale;
            return clamp({ scale: s, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k });
        });
    };

    /** Point of `e` relative to the stage's centre. */
    const fromCentre = (e: { clientX: number; clientY: number }) => {
        const rect = stageRef.current!.getBoundingClientRect();
        return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === "+" || e.key === "=") zoomTo(view.scale * STEP);
            else if (e.key === "-") zoomTo(view.scale / STEP);
            else if (e.key === "0") zoomTo(MIN_SCALE);
            else return;
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    const onWheel = (e: WheelEvent) => {
        zoomTo(view.scale * Math.exp(-e.deltaY * 0.002), fromCentre(e), false);
    };

    const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    };

    const onPointerMove = (e: PointerEvent) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        if (!d.moved) {
            d.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
        }
        d.x = e.clientX;
        d.y = e.clientY;
        if (view.scale === MIN_SCALE) return;
        setAnimate(false);
        setView((v) => clamp({ ...v, x: v.x + dx, y: v.y + dy }));
    };

    const onPointerUp = (e: PointerEvent) => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (!d || d.moved) return;
        // A click on the image toggles zoom; on the space around it, closes like a backdrop.
        if (e.target === imgRef.current) zoomTo(zoomed ? MIN_SCALE : STEP * STEP, fromCentre(e));
        else if (e.target === e.currentTarget) close.current?.click();
    };

    return (
        <>
            <header className="relative z-10 flex h-11 shrink-0 items-center gap-3 bg-black/40 pr-2 pl-4 text-sm">
                <span className="min-w-0 truncate text-white">{image.name}</span>
                <span className="shrink-0 text-xs text-white/60 tabular-nums">
                    {[natural && `${natural.width} × ${natural.height}`, formatBytes(image.size), counter]
                        .filter(Boolean)
                        .join("  ·  ")}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-0.5 text-white/80">
                    <IconButton
                        label="Zoom out"
                        tooltip="Zoom out (-)"
                        disabled={!zoomed}
                        onClick={() => zoomTo(view.scale / STEP)}
                        className={darkButton}
                    >
                        <MagnifyingGlassMinusIcon className="size-4" />
                    </IconButton>
                    <button
                        type="button"
                        aria-label="Reset zoom"
                        onClick={() => zoomTo(MIN_SCALE)}
                        className={cn(iconButtonClassName, darkButton, "w-12 text-xs tabular-nums")}
                    >
                        {Math.round(view.scale * fit * 100)}%
                    </button>
                    <IconButton
                        label="Zoom in"
                        tooltip="Zoom in (+)"
                        disabled={view.scale >= MAX_SCALE}
                        onClick={() => zoomTo(view.scale * STEP)}
                        className={darkButton}
                    >
                        <MagnifyingGlassPlusIcon className="size-4" />
                    </IconButton>
                    <IconButton
                        label="Open in default app"
                        onClick={() =>
                            void openFile(image.path).catch((e) =>
                                toast.error({ title: "Couldn't open the image", description: String(e) })
                            )
                        }
                        className={darkButton}
                    >
                        <ArrowSquareOutIcon className="size-4" />
                    </IconButton>
                    <DialogPrimitive.Close
                        ref={close}
                        aria-label="Close"
                        className={cn(iconButtonClassName, darkButton)}
                    >
                        <XIcon className="size-4" />
                    </DialogPrimitive.Close>
                </div>
            </header>
            <div
                ref={stageRef}
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                    drag.current = null;
                    setDragging(false);
                }}
                className={cn(
                    "relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-16 py-6 select-none",
                    zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : undefined
                )}
            >
                {url ? (
                    <img
                        ref={imgRef}
                        src={url}
                        alt={image.name}
                        draggable={false}
                        onLoad={(e) => {
                            const el = e.currentTarget;
                            setNatural({ width: el.naturalWidth, height: el.naturalHeight });
                            setFit(el.clientWidth / el.naturalWidth);
                        }}
                        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
                        className={cn(
                            "max-h-full max-w-full object-contain shadow-2xl shadow-black/50",
                            animate && "transition-transform duration-150 ease-out",
                            zoomed ? "cursor-[inherit]" : "cursor-zoom-in"
                        )}
                    />
                ) : (
                    <div className="size-24 animate-pulse rounded-lg bg-white/10" />
                )}
            </div>
        </>
    );
}
