import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DiffsPool } from "./features/chat/transcript/DiffsPool";
import { AppContextMenu } from "./layout/AppContextMenu";
import { ModalStack, Tooltip } from "./ui";
import "./index.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <DiffsPool>
            <Tooltip.Provider>
                <AppContextMenu>
                    <ModalStack>
                        <App />
                    </ModalStack>
                </AppContextMenu>
            </Tooltip.Provider>
        </DiffsPool>
    </StrictMode>
);
