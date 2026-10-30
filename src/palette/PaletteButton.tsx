import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Button, Tooltip } from "@/ui";
import { usePaletteStore } from "./store";

/** In the top bar's right corner, before Usage; Mod+K (by default) does the same. */
export function PaletteButton() {
    const toggle = usePaletteStore((s) => s.toggle);
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <Button
                        variant="ghost"
                        onClick={toggle}
                        aria-label="Command palette"
                        className="p-0 size-6"
                    >
                        <MagnifyingGlassIcon className="size-4" />
                    </Button>
                }
            />
            <Tooltip.Content side="bottom" shortcut="commandPalette">
                Search
            </Tooltip.Content>
        </Tooltip>
    );
}
