import { useEffect, useRef, useState } from "react";
import {
    ArrowLeftIcon,
    ChatCircleDotsIcon,
    CheckIcon,
    ShieldWarningIcon
} from "@phosphor-icons/react";
import type { UserInputAnswer, UserInputQuestion } from "@/proto";
import { cn } from "@/lib/cn";
import { Button } from "@/ui";

/** A permission prompt: two fixed choices, nothing to write in. */
function isPermission(q: UserInputQuestion) {
    return q.options.length === 2 && q.options[0] === "Allow" && q.options[1] === "Deny";
}

type Draft = { picked: string[]; custom: string };

const EMPTY: Draft = { picked: [], custom: "" };

function labelsOf(draft: Draft): string[] {
    const custom = draft.custom.trim();
    return custom ? [...draft.picked, custom] : draft.picked;
}

/**
 * An agent's questions, one step at a time, in place of the composer. A
 * single-choice question moves on as soon as an option is picked; several
 * choices, or an answer of one's own, take Next. Submit on the last step
 * sends every answer together (a permission prompt sends on the click), and
 * the wizard closes when the agent takes them.
 * Number keys pick options, Enter moves on.
 */
export function QuestionWizard({
    questions,
    onSubmit,
    className
}: {
    questions: UserInputQuestion[];
    onSubmit: (answers: UserInputAnswer[]) => Promise<void>;
    className?: string;
}) {
    const [step, setStep] = useState(0);
    const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY));
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string>();
    const rootRef = useRef<HTMLDivElement>(null);

    const question = questions[step];
    const draft = drafts[step] ?? EMPTY;
    const last = step === questions.length - 1;
    const answered = labelsOf(draft).length > 0;
    const permission = question ? isPermission(question) : false;

    useEffect(() => {
        rootRef.current?.focus();
    }, [step]);

    if (!question) return null;

    const edit = (change: (draft: Draft) => Draft) =>
        setDrafts((all) => all.map((d, i) => (i === step ? change(d) : d)));

    const send = (all: Draft[]) => {
        setSending(true);
        setError(undefined);
        onSubmit(
            questions.map((q, i) => ({
                questionId: q.id,
                labels: labelsOf(all[i] ?? EMPTY)
            }))
        ).catch((e: unknown) => {
            setSending(false);
            setError(e instanceof Error ? e.message : "The answer didn't go through.");
        });
    };

    const next = (all = drafts) => {
        if (!labelsOf(all[step] ?? EMPTY).length) return;
        if (last) send(all);
        else setStep(step + 1);
    };

    const pick = (option: string) => {
        if (sending) return;
        if (question.multiSelect) {
            edit((d) => ({
                ...d,
                picked: d.picked.includes(option)
                    ? d.picked.filter((p) => p !== option)
                    : [...d.picked, option]
            }));
            return;
        }
        const all = drafts.map((d, i) =>
            i === step ? { picked: [option], custom: "" } : d
        );
        setDrafts(all);
        // The last step waits for Submit, so the answers can be looked over;
        // a permission prompt is answered by the click.
        if (!last || permission) next(all);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.target instanceof HTMLInputElement) return;
        const n = Number(event.key);
        if (Number.isInteger(n) && n >= 1 && n <= question.options.length) {
            event.preventDefault();
            pick(question.options[n - 1]!);
        } else if (event.key === "Enter") {
            event.preventDefault();
            next();
        }
    };

    const Icon = permission ? ShieldWarningIcon : ChatCircleDotsIcon;

    return (
        <div
            ref={rootRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className={cn(
                "flex w-full flex-col gap-3 rounded-[22px] border border-dark-600 bg-dark-850 p-4 outline-none",
                "transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0",
                className
            )}
        >
            <div className="flex items-center gap-2 text-xs text-dark-200">
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate font-medium">{question.header}</span>
                {questions.length > 1 && (
                    <span className="ml-auto shrink-0 tabular-nums text-dark-300">
                        {step + 1} of {questions.length}
                    </span>
                )}
            </div>
            <p className="text-sm leading-6 whitespace-pre-wrap break-words text-dark-50">
                {question.question}
            </p>

            <div className="flex flex-col gap-1">
                {question.options.map((option, i) => {
                    const selected = draft.picked.includes(option);
                    return (
                        <button
                            key={option}
                            type="button"
                            disabled={sending}
                            aria-pressed={selected}
                            onClick={() => pick(option)}
                            className={cn(
                                "flex items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:pointer-events-none",
                                selected
                                    ? "bg-dark-700 text-dark-50"
                                    : "text-dark-100 hover:bg-dark-700/60 hover:text-dark-50"
                            )}
                        >
                            <span
                                className={cn(
                                    "flex size-5 shrink-0 items-center justify-center rounded-sm text-[11px] font-semibold tabular-nums transition-colors",
                                    selected ? "bg-primary-100 text-dark-900" : "bg-dark-700 text-dark-200"
                                )}
                            >
                                {question.multiSelect && selected ? (
                                    <CheckIcon className="size-3" weight="bold" />
                                ) : (
                                    i + 1
                                )}
                            </span>
                            <span className="min-w-0 break-words">{option}</span>
                        </button>
                    );
                })}
                {!permission && (
                    <input
                        value={draft.custom}
                        disabled={sending}
                        onChange={(event) => {
                            const custom = event.target.value;
                            edit((d) => ({
                                picked: question.multiSelect ? d.picked : [],
                                custom
                            }));
                        }}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                            event.preventDefault();
                            next();
                        }}
                        placeholder="Something else…"
                        className={cn(
                            "mt-1 h-9 min-w-0 rounded-md border border-dashed bg-transparent px-2.5 text-sm text-dark-50 outline-none transition-colors",
                            "placeholder:text-dark-300 hover:border-dark-500 focus:border-solid focus:border-dark-400 disabled:opacity-50",
                            draft.custom.trim() ? "border-dark-400" : "border-dark-600"
                        )}
                    />
                )}
            </div>

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="flex items-center gap-2">
                {questions.length > 1 && (
                    <div className="flex items-center gap-1" aria-hidden>
                        {questions.map((q, i) => (
                            <span
                                key={q.id}
                                className={cn(
                                    "size-1.5 rounded-full transition-colors",
                                    i === step
                                        ? "bg-dark-50"
                                        : labelsOf(drafts[i] ?? EMPTY).length
                                          ? "bg-dark-300"
                                          : "bg-dark-600"
                                )}
                            />
                        ))}
                    </div>
                )}
                <div className="ml-auto flex items-center gap-2">
                    {step > 0 && (
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={sending}
                            onClick={() => setStep(step - 1)}
                            leftIcon={<ArrowLeftIcon className="size-3" />}
                        >
                            Back
                        </Button>
                    )}
                    {(question.multiSelect || !permission) && (
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={!answered || sending}
                            loading={sending}
                            onClick={() => next()}
                        >
                            {last ? "Submit" : "Next"}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
