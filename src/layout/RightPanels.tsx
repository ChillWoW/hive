import { usePanelLayout, useLayoutStore } from "@/stores/useLayoutStore";
import { SidePanel } from "./SidePanel";

/** The right sidebar, then the file panel at the window's edge. */
export function RightPanels() {
    const layout = usePanelLayout();
    const setFilesWidth = useLayoutStore((s) => s.setFilesWidth);
    const setRightWidth = useLayoutStore((s) => s.setRightWidth);

    return (
        <>
            <SidePanel
                label="Right sidebar"
                width={layout.right}
                widthAt={(x) => window.innerWidth - layout.files - x}
                onResize={(width) =>
                    setRightWidth(Math.min(width, layout.rightMax))
                }
            />
            <SidePanel
                label="Files"
                width={layout.files}
                widthAt={(x) => window.innerWidth - x}
                onResize={(width) =>
                    setFilesWidth(Math.min(width, layout.filesMax))
                }
            />
        </>
    );
}
