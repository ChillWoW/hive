import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DiffsPool } from "./features/chat/transcript/DiffsPool";
import { ModalStack, Tooltip } from "./ui";
import "./index.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <DiffsPool>
            <Tooltip.Provider>
                <ModalStack>
                    <App />
                </ModalStack>
            </Tooltip.Provider>
        </DiffsPool>
    </StrictMode>
);
