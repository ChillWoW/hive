import { createContext } from "react";

/** The chat's folder, so paths inside it show relative and relative links resolve. */
export const ChatCwd = createContext<string | undefined>(undefined);

/**
 * Files the chat's agent read or changed, by folded path: an inline code span
 * naming one of them is a file link.
 */
export const KnownFiles = createContext<ReadonlySet<string>>(new Set());
