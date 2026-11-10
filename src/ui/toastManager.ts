import type { ReactNode } from "react";
import { Toast as BaseToast } from "@base-ui/react/toast";
import type { ToastManagerAddOptions, ToastManagerPromiseOptions } from "@base-ui/react/toast";

export type ToastType = "info" | "success" | "warning" | "error" | "loading";

type ToastOptions = Omit<ToastManagerAddOptions<object>, "type"> & { type?: ToastType };
type ToastInput = ReactNode | Omit<ToastOptions, "type">;

/** Shared outside React so anything (stores, async handlers) can raise a toast. */
export const toastManager = BaseToast.createToastManager();

function normalize(input: ToastInput, type: ToastType): ToastOptions {
    const isOptions =
        typeof input === "object" && input !== null && !("$$typeof" in input) && !Array.isArray(input);
    const options = isOptions ? (input as Omit<ToastOptions, "type">) : { title: input as ReactNode };
    // Loading toasts stay until updated or closed.
    return { ...(type === "loading" ? { timeout: 0 } : {}), ...options, type };
}

const add = (type: ToastType) => (input: ToastInput) => toastManager.add(normalize(input, type));

/** `toast("Saved")`, `toast.error({ title, description })`, `toast.promise(p, {...})`. */
export const toast = Object.assign(add("info"), {
    info: add("info"),
    success: add("success"),
    warning: add("warning"),
    error: add("error"),
    loading: add("loading"),
    update: toastManager.update,
    close: toastManager.close,
    promise: <T>(promise: Promise<T>, options: ToastManagerPromiseOptions<T, object>) =>
        toastManager.promise(promise, options)
});
