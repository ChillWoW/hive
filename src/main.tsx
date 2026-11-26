import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { App } from "./App";
import { DIFFS_POOL } from "./features/chat/transcript/diffsPool";
import { ModalStack, Tooltip } from "./ui";
import "./index.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <WorkerPoolContextProvider {...DIFFS_POOL}>
            <Tooltip.Provider>
                <ModalStack>
                    <App />
                </ModalStack>
            </Tooltip.Provider>
        </WorkerPoolContextProvider>
    </StrictMode>
);
