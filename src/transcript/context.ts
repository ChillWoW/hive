import { createContext } from "react";
import type { BackgroundTask } from "@/proto";

/** The chat's folder, so paths inside it show relative. */
export const ChatCwd = createContext<string | undefined>(undefined);

/** Opens a subagent's thread by its spawn id; unset, subagent rows aren't clickable. */
export const OpenSubagent = createContext<((id: string) => void) | undefined>(undefined);

/** The session's live background tasks: a subagent among them still runs past its turn. */
export const LiveTasks = createContext<BackgroundTask[]>([]);
