import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { isTauri } from "./platform";

const NO_BACKEND = "Needs the Outcode app; there's no backend under `bun run dev`.";

/**
 * `invoke(command, args, options)` in the app. Under plain `bun run dev` there
 * is no backend: `dev` stands in for it when given (its result, sync or not),
 * else the call rejects with `NO_BACKEND`.
 */
export function backend<T>(
    command: string,
    args?: InvokeArgs,
    dev?: () => T | Promise<T>,
    options?: InvokeOptions
): Promise<T> {
    if (isTauri) return invoke<T>(command, args, options);
    return dev ? Promise.resolve(dev()) : Promise.reject(new Error(NO_BACKEND));
}
