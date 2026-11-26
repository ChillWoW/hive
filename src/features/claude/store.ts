import { makeProvider } from "@/features/providers/makeProvider";
import { claudeApi } from "./api";

export { availableUpdate } from "@/features/providers/makeProvider";

/** Claude Code as a provider: its status, login, updates and plan usage. */
export const claude = makeProvider("Claude Code", claudeApi);

export const useClaudeProvider = claude.useProvider;
export const refreshClaude = claude.refresh;
export const claudeProvider = claude.actions;
