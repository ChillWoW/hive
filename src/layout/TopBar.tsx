import { isMac } from "@/lib/platform";
import { WindowControls } from "./WindowControls";

/** The frameless window's title strip: draggable, with the window controls on Windows/Linux. */
export function TopBar() {
    return (
        <header
            data-tauri-drag-region
            className="flex h-9 shrink-0 select-none items-center justify-end"
        >
            {!isMac && <WindowControls />}
        </header>
    );
}
