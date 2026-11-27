import { makeProvider } from "@/features/providers/makeProvider";
import { antigravityApi } from "./api";

/** Antigravity as a provider: its status, Google login, updates and model quota. */
export const antigravity = makeProvider("Antigravity", antigravityApi);
