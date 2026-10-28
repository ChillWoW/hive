import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOutIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { isTauri } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { afterChange, providersApi } from "@/providers";
import type { HarnessCatalog, SignInMethod } from "@/proto";
import { Button, Input, Modal } from "@/ui";

type Step =
    | { kind: "choose" }
    | { kind: "starting"; method: SignInMethod }
    | { kind: "code"; loginId: string; url: string }
    | { kind: "failed"; message: string };

const METHODS: { method: SignInMethod; label: string; description: string }[] = [
    {
        method: "subscription",
        label: "Claude subscription",
        description: "Pro, Max, Team or Enterprise"
    },
    {
        method: "console",
        label: "Anthropic Console",
        description: "Billed per use through the API"
    }
];

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function open(url: string) {
    if (isTauri) void openUrl(url);
    else window.open(url, "_blank", "noopener");
}

/**
 * The CLI's own sign-in: it opens Claude's page in the browser, which shows
 * a code once access is approved; the code goes back to the CLI here. A new
 * login replaces the current one. Closed while `catalog` is null.
 */
export function SignInDialog({
    catalog,
    onClose
}: {
    catalog: HarnessCatalog | null;
    onClose: () => void;
}) {
    // Kept while the dialog animates out.
    const [shown, setShown] = useState(catalog);
    const [step, setStep] = useState<Step>({ kind: "choose" });
    const [code, setCode] = useState("");
    const [verifying, setVerifying] = useState(false);
    const [codeError, setCodeError] = useState<string | null>(null);
    // The login the CLI is holding open, so closing can end it.
    const pending = useRef<string | null>(null);
    // Bumped on close, so a start that lands afterwards is dropped.
    const session = useRef(0);

    useEffect(() => {
        if (!catalog) return;
        setShown(catalog);
        setStep({ kind: "choose" });
        setCode("");
        setCodeError(null);
    }, [catalog]);

    const cancelPending = () => {
        if (pending.current) void providersApi.cancelSignIn(pending.current);
        pending.current = null;
    };

    const close = () => {
        session.current++;
        cancelPending();
        onClose();
    };

    // Unmounting mid-sign-in (the settings modal closing) ends it too.
    useEffect(() => () => cancelPending(), []);

    const start = async (method: SignInMethod) => {
        if (!shown) return;
        const mine = ++session.current;
        setStep({ kind: "starting", method });
        setCode("");
        setCodeError(null);
        try {
            const started = await providersApi.signIn(shown.id, method);
            if (mine !== session.current) {
                void providersApi.cancelSignIn(started.loginId);
                return;
            }
            pending.current = started.loginId;
            setStep({ kind: "code", loginId: started.loginId, url: started.url });
        } catch (error) {
            if (mine === session.current) setStep({ kind: "failed", message: message(error) });
        }
    };

    const finish = async () => {
        if (step.kind !== "code" || !shown || !code.trim()) return;
        const mine = session.current;
        setVerifying(true);
        setCodeError(null);
        // The CLI is done with this login whatever happens.
        pending.current = null;
        try {
            await providersApi.finishSignIn(step.loginId, code);
            await afterChange(shown.id);
            if (mine === session.current) onClose();
        } catch (error) {
            if (mine === session.current) setStep({ kind: "failed", message: message(error) });
        } finally {
            setVerifying(false);
        }
    };

    return (
        <Modal
            open={catalog !== null}
            onOpenChange={(next) => !next && close()}
            title={`Sign in to ${shown?.label ?? ""}`}
            size="sm"
        >
            {step.kind === "choose" && (
                <>
                    <p>Which account should {shown?.label} use?</p>
                    <div className="mt-3 flex flex-col gap-1.5">
                        {METHODS.map(({ method, label, description }, i) => (
                            <button
                                key={method}
                                type="button"
                                autoFocus={i === 0}
                                onClick={() => void start(method)}
                                className={cn(
                                    "flex flex-col items-start gap-0.5 rounded-md border border-dark-600 bg-dark-800 px-3 py-2 text-left",
                                    "transition-colors hover:border-dark-500 hover:bg-dark-700 focus-visible:border-dark-400 focus-visible:outline-none"
                                )}
                            >
                                <span className="text-[13px] font-medium text-dark-50">
                                    {label}
                                </span>
                                <span className="text-xs text-dark-250">{description}</span>
                            </button>
                        ))}
                    </div>
                    <p className="mt-3 text-xs text-dark-300">
                        Signing in replaces the account {shown?.label} uses now, here and in
                        your terminal.
                    </p>
                    <div className="mt-4 flex justify-end">
                        <Button size="sm" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                    </div>
                </>
            )}

            {step.kind === "starting" && (
                <>
                    <p className="flex items-center gap-2">
                        <CircleNotchIcon weight="bold" className="size-3.5 animate-spin" />
                        Opening the sign-in page…
                    </p>
                    <div className="mt-4 flex justify-end">
                        <Button size="sm" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                    </div>
                </>
            )}

            {step.kind === "code" && (
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void finish();
                    }}
                >
                    <p>
                        Approve access in your browser, then paste the code the page shows.
                    </p>
                    <button
                        type="button"
                        onClick={() => open(step.url)}
                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-dark-200 underline-offset-2 transition-colors hover:text-dark-50 hover:underline"
                    >
                        <ArrowSquareOutIcon className="size-3" />
                        Reopen the sign-in page
                    </button>
                    <Input
                        autoFocus
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        placeholder="Paste the code"
                        aria-label="Sign-in code"
                        spellCheck={false}
                        autoComplete="off"
                        disabled={verifying}
                        invalid={codeError !== null}
                        className="mt-3 w-full font-mono text-xs"
                    />
                    {codeError && <p className="mt-2 text-xs text-danger">{codeError}</p>}
                    <div className="mt-4 flex justify-end gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="sm"
                            variant="primary"
                            loading={verifying}
                            disabled={!code.trim()}
                        >
                            {verifying ? "Verifying…" : "Sign in"}
                        </Button>
                    </div>
                </form>
            )}

            {step.kind === "failed" && (
                <>
                    <p className="text-xs whitespace-pre-line text-danger">{step.message}</p>
                    <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={close}>
                            Close
                        </Button>
                        <Button
                            size="sm"
                            variant="default"
                            autoFocus
                            onClick={() => setStep({ kind: "choose" })}
                        >
                            Try again
                        </Button>
                    </div>
                </>
            )}
        </Modal>
    );
}
