import { makeProvider } from "@/features/providers/makeProvider";
import { codexApi } from "./api";

/** Codex as a provider: its status, ChatGPT login, updates and plan usage. */
export const codex = makeProvider("Codex", codexApi);
