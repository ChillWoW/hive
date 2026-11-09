import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

const NO_BACKEND = "Needs the Hive app; there's no backend under `bun run dev`.";

/**
 * `invoke(command, args)` in the app. Under plain `bun run dev` there is no
 * backend: `dev` stands in for it when given (its result, sync or not), else
 * the call rejects with `NO_BACKEND`.
 */
export function backend<T>(
    command: string,
    args?: InvokeArgs,
    dev?: () => T | Promise<T>
): Promise<T> {
    if (isTauri) return invoke<T>(command, args);
    return dev ? Promise.resolve(dev()) : Promise.reject(new Error(NO_BACKEND));
}
