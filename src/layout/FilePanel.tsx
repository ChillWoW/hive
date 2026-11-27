import { FileExplorer } from "@/features/files";
import { SidePanel } from "./SidePanel";
import { usePanelShown } from "./store";

/** The file panel: a search over the chat folder's files, then its tree. */
export function FilePanel() {
    const shown = usePanelShown("files");
    return (
        <SidePanel panel="files" label="Files">
            <FileExplorer shown={shown} />
        </SidePanel>
    );
}
