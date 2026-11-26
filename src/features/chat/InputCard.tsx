import { use, useEffect, useRef, useState, type ReactNode } from "react";
import {
    ArrowLeftIcon,
    ChatCircleDotsIcon,
    CheckIcon,
    ClipboardTextIcon,
    PencilSimpleIcon,
    ShieldWarningIcon,
    TerminalWindowIcon
} from "@phosphor-icons/react";
import type { InputRequest, InputResponse, UserInputAnswer, UserInputQuestion } from "@/proto";
import { cn } from "@/lib/cn";
import { Button } from "@/ui";
import { cardClassName } from "./cards";
import type { InputPart } from "./fold";
import { ChatCwd } from "./transcript/context";
import { Markdown } from "./transcript/Markdown";
import { shortPath } from "./transcript/tools";

function Heading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <div className="flex items-center gap-2 text-xs text-muted">
            {icon}
            <span className="min-w-0 truncate font-medium">{children}</span>
        </div>
    );
}

/**
 * What the agent waits on, above the composer: an approval (allow once, for
 * the session, or deny), its questions (one tab each), or plan mode's plan
 * (implement it, or keep planning with feedback).
 */
export function InputCard({ part, onAnswer }: { part: InputPart; onAnswer: (response: InputResponse) => void }) {
    const { request } = part;
    switch (request.kind) {
        case "approval":
            return <ApprovalCard request={request} onAnswer={onAnswer} />;
        case "questions":
            return <QuestionsCard key={part.requestId} questions={request.questions} onAnswer={onAnswer} />;
        case "plan":
            return <PlanCard key={part.requestId} plan={request.plan} onAnswer={onAnswer} />;
    }
}

function ApprovalCard({
    request,
    onAnswer
}: {
    request: Extract<InputRequest, { kind: "approval" }>;
    onAnswer: (response: InputResponse) => void;
}) {
    const cwd = use(ChatCwd);
    const call = request.call;
    const decide = (decision: "allow" | "allowSession" | "deny") => onAnswer({ kind: "approval", decision });
    const icon =
        call?.kind === "exec" ? (
            <TerminalWindowIcon className="size-3.5 shrink-0" />
        ) : call?.kind === "editFile" || call?.kind === "writeFile" ? (
            <PencilSimpleIcon className="size-3.5 shrink-0" />
        ) : (
            <ShieldWarningIcon className="size-3.5 shrink-0" />
        );
    let detail: string | undefined;
    if (call?.kind === "exec") detail = `$ ${call.command}`;
    else if (call?.kind === "editFile" || call?.kind === "writeFile" || call?.kind === "readFile") {
        detail = shortPath(call.path, cwd);
    } else if (call?.kind === "webFetch") detail = call.url;
    else if (call?.kind === "webSearch") detail = call.query;
    else if (call?.kind === "mcp" || call?.kind === "unknown") {
        detail = call.input === undefined ? undefined : JSON.stringify(call.input, null, 2);
    }
    const preview = call?.kind === "editFile" ? call.newString : call?.kind === "writeFile" ? call.content : undefined;

    return (
        <div className={cardClassName}>
            <Heading icon={icon}>{request.title}</Heading>
            {request.reason && <p className="text-sm leading-6 text-text">{request.reason}</p>}
            {detail && (
                <pre className="max-h-40 overflow-auto rounded-lg bg-raised px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre-wrap text-text">
                    {detail}
                </pre>
            )}
            {preview && (
                <pre className="max-h-40 overflow-auto rounded-lg bg-raised px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre text-success/90">
                    {preview}
                </pre>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => decide("deny")}>
                    Deny
                </Button>
                <Button variant="secondary" size="sm" onClick={() => decide("allowSession")}>
                    Allow for this session
                </Button>
                <Button size="sm" onClick={() => decide("allow")}>
                    Allow
                </Button>
            </div>
        </div>
    );
}

/** A question's answer so far: options picked, and text of one's own. */
type Draft = { picked: string[]; custom: string };

const EMPTY: Draft = { picked: [], custom: "" };

function labelsOf(draft: Draft = EMPTY): string[] {
    const custom = draft.custom.trim();
    return custom ? [...draft.picked, custom] : draft.picked;
}

/**
 * The agent's questions, one tab each. A single-choice question moves to
 * the next tab as soon as an option is picked; several choices, or an
 * answer of one's own, take Next. Submit on the last tab sends every answer
 * together, or goes to the first one still unanswered. Number keys pick
 * options, Enter moves on.
 */
function QuestionsCard({
    questions,
    onAnswer
}: {
    questions: UserInputQuestion[];
    onAnswer: (response: InputResponse) => void;
}) {
    const [step, setStep] = useState(0);
    const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY));
    const rootRef = useRef<HTMLDivElement>(null);
    const question = questions[step];
    const draft = drafts[step] ?? EMPTY;
    const last = step === questions.length - 1;
    const answered = labelsOf(draft).length > 0;

    useEffect(() => {
        rootRef.current?.focus();
    }, [step]);

    if (!question) return null;

    const edit = (change: (draft: Draft) => Draft) =>
        setDrafts((all) => all.map((d, i) => (i === step ? change(d) : d)));

    const next = (all = drafts) => {
        if (!labelsOf(all[step]).length) return;
        if (!last) return setStep(step + 1);
        const missing = all.findIndex((d) => !labelsOf(d).length);
        if (missing !== -1) return setStep(missing);
        const answers: UserInputAnswer[] = questions.map((q, i) => ({ questionId: q.id, labels: labelsOf(all[i]) }));
        onAnswer({ kind: "questions", answers });
    };

    const pick = (label: string) => {
        if (question.multiSelect) {
            edit((d) => ({
                ...d,
                picked: d.picked.includes(label) ? d.picked.filter((p) => p !== label) : [...d.picked, label]
            }));
            return;
        }
        setDrafts((all) => all.map((d, i) => (i === step ? { picked: [label], custom: "" } : d)));
        // The last tab waits for Submit, so the answers can be looked over.
        if (!last) setStep(step + 1);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.target instanceof HTMLInputElement) return;
        const n = Number(event.key);
        if (Number.isInteger(n) && n >= 1 && n <= question.options.length) {
            event.preventDefault();
            pick(question.options[n - 1]!.label);
        } else if (event.key === "Enter") {
            event.preventDefault();
            next();
        }
    };

    return (
        <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className={cardClassName}>
            <Heading icon={<ChatCircleDotsIcon className="size-3.5 shrink-0" />}>
                {questions.length === 1 ? "Claude has a question" : `Claude has ${questions.length} questions`}
            </Heading>
            {questions.length > 1 && (
                <div role="tablist" aria-label="Questions" className="-mx-1 flex gap-1 overflow-x-auto">
                    {questions.map((q, i) => {
                        const done = labelsOf(drafts[i]).length > 0;
                        return (
                            <button
                                key={q.id}
                                type="button"
                                role="tab"
                                aria-selected={i === step}
                                onClick={() => setStep(i)}
                                className={cn(
                                    "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors outline-none",
                                    i === step ? "bg-hover text-text" : "text-muted hover:bg-hover/60 hover:text-text"
                                )}
                            >
                                {done ? (
                                    <CheckIcon className="size-3 text-success" weight="bold" />
                                ) : (
                                    <span className="text-muted/70 tabular-nums">{i + 1}</span>
                                )}
                                {q.header}
                            </button>
                        );
                    })}
                </div>
            )}
            <p className="text-sm leading-6 break-words whitespace-pre-wrap text-text">{question.question}</p>
            <div role="tabpanel" className="flex flex-col gap-1">
                {question.options.map((option, i) => {
                    const selected = draft.picked.includes(option.label);
                    return (
                        <button
                            key={option.label}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => pick(option.label)}
                            className={cn(
                                "flex items-start gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                                selected ? "bg-hover text-text" : "text-text/90 hover:bg-hover/60 hover:text-text"
                            )}
                        >
                            <span
                                className={cn(
                                    "flex size-5 shrink-0 items-center justify-center rounded-sm text-[11px] font-semibold tabular-nums transition-colors",
                                    selected ? "bg-accent text-accent-fg" : "bg-raised text-muted"
                                )}
                            >
                                {question.multiSelect && selected ? <CheckIcon className="size-3" weight="bold" /> : i + 1}
                            </span>
                            <span className="flex min-w-0 flex-col">
                                <span className="break-words">{option.label}</span>
                                {option.description && option.description !== option.label && (
                                    <span className="text-xs text-muted">{option.description}</span>
                                )}
                            </span>
                        </button>
                    );
                })}
                <input
                    value={draft.custom}
                    onChange={(event) => {
                        const custom = event.target.value;
                        edit((d) => ({ picked: question.multiSelect ? d.picked : [], custom }));
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        next();
                    }}
                    placeholder="Something else…"
                    className={cn(
                        "mt-1 h-9 min-w-0 rounded-md border border-dashed bg-transparent px-2.5 text-sm text-text outline-none transition-colors",
                        "placeholder:text-muted/70 hover:border-muted/50 focus:border-solid focus:border-muted/60",
                        draft.custom.trim() ? "border-muted/60" : "border-border"
                    )}
                />
            </div>
            <div className="flex items-center justify-end gap-2">
                {step > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setStep(step - 1)}>
                        <ArrowLeftIcon className="size-3" />
                        Back
                    </Button>
                )}
                <Button size="sm" disabled={!answered} onClick={() => next()}>
                    {last ? "Submit" : "Next"}
                </Button>
            </div>
        </div>
    );
}

function PlanCard({ plan, onAnswer }: { plan: string; onAnswer: (response: InputResponse) => void }) {
    const [feedback, setFeedback] = useState("");
    return (
        <div className={cardClassName}>
            <Heading icon={<ClipboardTextIcon className="size-3.5 shrink-0" />}>Plan ready for review</Heading>
            <div className="max-h-[40vh] overflow-y-auto rounded-lg bg-raised px-4 py-3">
                <Markdown className="markdown-small">{plan || "_The plan is empty._"}</Markdown>
            </div>
            <input
                value={feedback}
                placeholder="What should change? (keeps planning)"
                onChange={(event) => setFeedback(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && feedback.trim()) {
                        onAnswer({ kind: "plan", approve: false, feedback: feedback.trim() });
                    }
                }}
                className="h-9 rounded-md border border-dashed border-border bg-transparent px-2.5 text-sm text-text outline-none placeholder:text-muted/70 hover:border-muted/50 focus:border-solid focus:border-muted/60"
            />
            <div className="flex items-center justify-end gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAnswer({ kind: "plan", approve: false, feedback: feedback.trim() || undefined })}
                >
                    Keep planning
                </Button>
                <Button size="sm" onClick={() => onAnswer({ kind: "plan", approve: true })}>
                    Approve and implement
                </Button>
            </div>
        </div>
    );
}
