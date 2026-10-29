import { useState } from "react";
import { usePanelLayout, useLayoutStore } from "@/stores/useLayoutStore";
import { FilesPanel } from "@/files";
import { RightSidebar } from "@/rightbar";
import { SidePanel } from "./SidePanel";

/** The right sidebar, then the file panel at the window's edge. */
export function RightPanels() {
    const layout = usePanelLayout();
    const setFilesWidth = useLayoutStore((s) => s.setFilesWidth);
    const setRightWidth = useLayoutStore((s) => s.setRightWidth);
    // Mounted on first open, then kept, so closing slides its content away.
    const [filesMounted, setFilesMounted] = useState(layout.visible.files);
    if (layout.visible.files && !filesMounted) setFilesMounted(true);

    return (
        <>
            <SidePanel
                label="Right sidebar"
                width={layout.right}
                widthAt={(x) => window.innerWidth - layout.files - x}
                onResize={(width) =>
                    setRightWidth(Math.min(width, layout.rightMax))
                }
            >
                <RightSidebar />
            </SidePanel>
            <SidePanel
                label="Files"
                width={layout.files}
                widthAt={(x) => window.innerWidth - x}
                onResize={(width) =>
                    setFilesWidth(Math.min(width, layout.filesMax))
                }
            >
                {filesMounted && <FilesPanel />}
            </SidePanel>
        </>
    );
}
