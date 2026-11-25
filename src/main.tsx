import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ModalStack, Tooltip } from "./ui";
import "./index.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Tooltip.Provider>
            <ModalStack>
                <App />
            </ModalStack>
        </Tooltip.Provider>
    </StrictMode>
);
