import { createContext } from "react";

/** The chat's folder, so paths inside it show relative. */
export const ChatCwd = createContext<string | undefined>(undefined);
