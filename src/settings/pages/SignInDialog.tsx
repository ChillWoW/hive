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
    // The browser finishes the sign-in itself (Codex): no code, just waiting.
    | { kind: "browser"; loginId: string; url: string }
    | { kind: "failed"; message: string };

type Method = { method: SignInMethod; label: string; description: string };

const CLAUDE_METHODS: Method[] = [
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

/** Codex signs in with ChatGPT only. */
const CODEX_METHODS: Method[] = [
    {
        method: "subscription",
        label: "ChatGPT",
        description: "Plus, Pro, Business, Edu or Enterprise"
    }
];

function methodsFor(catalog: HarnessCatalog | null): Method[] {
    return catalog?.id === "codex" ? CODEX_METHODS : CLAUDE_METHODS;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function open(url: string) {
    if (isTauri) void openUrl(url);
    else window.open(url, "_blank", "noopener");
}

/**
 * The CLI's own sign-in. Claude: it opens Claude's page in the browser, which shows
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
        // One way in: nothing to choose.
        const methods = methodsFor(catalog);
        if (methods.length === 1) void start(methods[0]!.method, catalog);
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const start = async (method: SignInMethod, target: HarnessCatalog | null = shown) => {
        if (!target) return;
        const mine = ++session.current;
        setStep({ kind: "starting", method });
        setCode("");
        setCodeError(null);
        try {
            const started = await providersApi.signIn(target.id, method);
            if (mine !== session.current) {
                void providersApi.cancelSignIn(started.loginId);
                return;
            }
            pending.current = started.loginId;
            if (started.needsCode) {
                setStep({ kind: "code", loginId: started.loginId, url: started.url });
                return;
            }
            // The CLI waits for the browser; finishing just waits with it.
            setStep({ kind: "browser", loginId: started.loginId, url: started.url });
            open(started.url);
            await providersApi.finishSignIn(started.loginId, "");
            pending.current = null;
            await afterChange(target.id);
            if (mine === session.current) onClose();
        } catch (error) {
            if (mine === session.current) {
                pending.current = null;
                setStep({ kind: "failed", message: message(error) });
            }
        }
    };

    const retry = () => {
        const methods = methodsFor(shown);
        if (methods.length === 1) void start(methods[0]!.method);
        else setStep({ kind: "choose" });
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
                        {methodsFor(shown).map(({ method, label, description }, i) => (
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
                    <p className="mt-3 text-xs text-dark-250">
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

            {step.kind === "browser" && (
                <>
                    <p className="flex items-center gap-2">
                        <CircleNotchIcon weight="bold" className="size-3.5 animate-spin" />
                        Approve access in your browser. Hive signs in once you do.
                    </p>
                    <button
                        type="button"
                        onClick={() => open(step.url)}
                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-dark-200 underline-offset-2 transition-colors hover:text-dark-50 hover:underline"
                    >
                        <ArrowSquareOutIcon className="size-3" />
                        Reopen the sign-in page
                    </button>
                    <div className="mt-4 flex justify-end">
                        <Button size="sm" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                    </div>
                </>
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
                            onClick={retry}
                        >
                            Try again
                        </Button>
                    </div>
                </>
            )}
        </Modal>
    );
}
