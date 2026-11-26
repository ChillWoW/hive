import { createContext } from "react";
import type { BackgroundTask } from "@/proto";

/** The session's live background tasks: a subagent among them still runs past its turn. */
export const LiveTasks = createContext<readonly BackgroundTask[]>([]);

/** The chat's folder, so paths inside it show relative and relative links resolve. */
export const ChatCwd = createContext<string | undefined>(undefined);

/**
 * Files the chat's agent read or changed, by folded path: an inline code span
 * naming one of them is a file link.
 */
export const KnownFiles = createContext<ReadonlySet<string>>(new Set());
