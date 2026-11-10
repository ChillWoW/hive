import { SidePanel } from "./SidePanel";

/** The file panel's column, at the window's right edge: the file tree to come. */
export function FilePanel() {
    return (
        <SidePanel panel="files" label="Files">
            <div className="min-h-0 flex-1" />
        </SidePanel>
    );
}
