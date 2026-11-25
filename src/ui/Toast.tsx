import type { ReactNode } from "react";
import { Toast as BaseToast } from "@base-ui/react/toast";
import {
    CheckCircleIcon,
    CircleNotchIcon,
    InfoIcon,
    WarningIcon,
    XCircleIcon,
    XIcon
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { toastManager } from "./toastManager";
import type { ToastType } from "./toastManager";

const typeIcon: Record<ToastType, ReactNode> = {
    info: <InfoIcon weight="fill" className="size-4 text-muted" />,
    success: <CheckCircleIcon weight="fill" className="size-4 text-success" />,
    warning: <WarningIcon weight="fill" className="size-4 text-warning" />,
    error: <XCircleIcon weight="fill" className="size-4 text-danger" />,
    loading: <CircleNotchIcon weight="bold" className="size-4 animate-spin text-muted" />
};

function ToastList() {
    const { toasts } = BaseToast.useToastManager();
    return toasts.map((t) => {
        const icon = typeIcon[(t.type as ToastType | undefined) ?? "info"] ?? typeIcon.info;
        return (
            <BaseToast.Root
                key={t.id}
                toast={t}
                className={cn(
                    "toast pointer-events-auto rounded-md border border-border bg-surface bg-clip-padding",
                    "shadow-lg shadow-black/40"
                )}
            >
                <BaseToast.Content className="toast-content flex items-start gap-2.5 py-2.5 pr-8 pl-3">
                    <span className="mt-px inline-flex shrink-0">{icon}</span>
                    <div className="min-w-0 flex-1">
                        <BaseToast.Title className="text-sm font-medium text-text" />
                        <BaseToast.Description className="mt-0.5 text-xs text-muted empty:hidden" />
                        {t.actionProps && (
                            <BaseToast.Action
                                className={cn(
                                    "mt-2 inline-flex h-6 items-center rounded-md bg-raised px-2.5 text-xs font-medium",
                                    "text-text transition-colors hover:bg-hover active:bg-border"
                                )}
                            />
                        )}
                    </div>
                    <BaseToast.Close
                        aria-label="Dismiss"
                        className={cn(
                            "absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded",
                            "text-muted transition-colors hover:bg-hover hover:text-text"
                        )}
                    >
                        <XIcon className="size-3" weight="bold" />
                    </BaseToast.Close>
                </BaseToast.Content>
            </BaseToast.Root>
        );
    });
}

/** Mount once near the app root; toasts stack in the bottom-right corner. */
export function Toaster() {
    return (
        <BaseToast.Provider toastManager={toastManager}>
            <BaseToast.Portal>
                <BaseToast.Viewport className="fixed right-4 bottom-4 z-[60] w-[22rem] outline-none">
                    <ToastList />
                </BaseToast.Viewport>
            </BaseToast.Portal>
        </BaseToast.Provider>
    );
}
