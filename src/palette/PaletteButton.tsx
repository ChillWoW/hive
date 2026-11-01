import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { BarButton } from "@/layout/BarButton";
import { usePaletteStore } from "./store";

/** In the top bar's right corner, before Usage; Mod+K (by default) does the same. */
export function PaletteButton() {
    const toggle = usePaletteStore((s) => s.toggle);
    return (
        <BarButton label="Command palette" tooltip="Search" shortcut="commandPalette" onClick={toggle}>
            <MagnifyingGlassIcon className="size-4" />
        </BarButton>
    );
}
