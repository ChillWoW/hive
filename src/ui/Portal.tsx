import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type PortalTarget = HTMLElement | ShadowRoot | null;

export interface PortalProps {
    children?: ReactNode;
    /** Element (or ref to one) to render into. Defaults to `document.body`. */
    container?: PortalTarget | RefObject<PortalTarget>;
}

/**
 * Renders children into another part of the DOM (default `document.body`) while keeping
 * them in the React tree, so context and events still flow from where it's used.
 *
 * For custom overlays only: Base UI components (Dialog, Popover, ...) ship their own
 * context-aware `*.Portal` with the same `container` prop; use that instead.
 */
export function Portal({ children, container }: PortalProps) {
    const [target, setTarget] = useState<PortalTarget>(null);

    // Resolved after mount so a ref container has been attached; syncing with the DOM is
    // what this effect is for.
    useLayoutEffect(() => {
        const resolved = isRef(container) ? container.current : container;
        // oxlint-disable-next-line react/set-state-in-effect
        setTarget(resolved ?? document.body);
    }, [container]);

    return target ? createPortal(children, target) : null;
}

function isRef(value: PortalProps["container"]): value is RefObject<PortalTarget> {
    return value != null && "current" in value;
}
