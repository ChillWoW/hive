import { use, type ReactNode } from "react";
import {
    ChatCircleDotsIcon,
    CheckCircleIcon,
    ClipboardTextIcon,
    HourglassMediumIcon,
    ProhibitIcon,
    ShieldCheckIcon
} from "@phosphor-icons/react";
import type { InputRequest, InputResponse } from "@/proto";
import { cn } from "@/lib/cn";
import type { InputPart } from "../fold";
import { ChatCwd } from "./context";
import { Markdown } from "./Markdown";
import { chipContent } from "./tools";

/** What a call asked to do, in a few words: "Run bun run lint", "Edit lib.rs". */
function approvalSummary(request: Extract<InputRequest, { kind: "approval" }>, cwd?: string): string {
    if (!request.call) return request.title;
    const { label, detail } = chipContent(request.call, cwd);
    return detail ? `${label} ${detail}` : request.title;
}

/** One quiet line in the transcript: an icon, what happened, what it was about. */
function RecordLine({ icon, state, children }: { icon: ReactNode; state: ReactNode; children?: ReactNode }) {
    return (
        <div className="flex min-h-[26px] min-w-0 items-center gap-2 text-[13px]">
            {icon}
            <span className="shrink-0 text-muted/85">{state}</span>
            {children && <span className="min-w-0 truncate text-muted">{children}</span>}
        </div>
    );
}

const waiting = <HourglassMediumIcon className="size-3.5 shrink-0 text-warning" />;

/**
 * What the agent asked mid-turn, as the transcript keeps it: the approval
 * and how it went, the questions and their answers, or the plan. The open
 * one is answered on the card above the composer.
 */
export function InputRecord({ part }: { part: InputPart }) {
    const cwd = use(ChatCwd);
    const { request, response, resolved } = part;
    const pending = !resolved;
    const unanswered = resolved && !response;

    if (request.kind === "approval") {
        const summary = approvalSummary(request, cwd);
        if (pending) {
            return (
                <RecordLine icon={waiting} state="Needs approval">
                    {summary}
                </RecordLine>
            );
        }
        const decision = response?.kind === "approval" ? response.decision : undefined;
        const [icon, state] =
            decision === "allow"
                ? [<CheckCircleIcon key="i" className="size-3.5 shrink-0 text-success" />, "Allowed"]
                : decision === "allowSession"
                  ? [<ShieldCheckIcon key="i" className="size-3.5 shrink-0 text-success" />, "Allowed for this session"]
                  : decision === "deny"
                    ? [<ProhibitIcon key="i" className="size-3.5 shrink-0 text-danger" />, "Denied"]
                    : [<ProhibitIcon key="i" className="size-3.5 shrink-0 text-muted/70" />, "Not answered"];
        return (
            <RecordLine icon={icon} state={state}>
                {summary}
            </RecordLine>
        );
    }

    if (request.kind === "questions") {
        const answers = response?.kind === "questions" ? response.answers : [];
        return (
            <div className="flex flex-col gap-1">
                <RecordLine
                    icon={pending ? waiting : <ChatCircleDotsIcon className="size-3.5 shrink-0 text-muted/70" />}
                    state={
                        pending
                            ? request.questions.length === 1
                                ? "Asked a question"
                                : `Asked ${request.questions.length} questions`
                            : unanswered
                              ? "Questions not answered"
                              : "Answered"
                    }
                />
                {!pending && !unanswered && (
                    <dl className="ml-[22px] flex flex-col gap-1 border-l border-border pl-3 text-[13px]">
                        {request.questions.map((q) => {
                            const labels = answers.find((a) => a.questionId === q.id)?.labels ?? [];
                            return (
                                <div key={q.id} className="flex flex-col">
                                    <dt className="text-muted">{q.question}</dt>
                                    <dd className="text-text/90">{labels.length ? labels.join(", ") : "—"}</dd>
                                </div>
                            );
                        })}
                    </dl>
                )}
            </div>
        );
    }

    // The card above the composer shows the plan while it waits.
    if (pending) {
        return <RecordLine icon={waiting} state="Plan ready" />;
    }
    return <PlanRecord plan={request.plan} pending={pending} response={response} />;
}

function PlanRecord({ plan, pending, response }: { plan: string; pending: boolean; response?: InputResponse }) {
    const outcome = response?.kind === "plan" ? response : undefined;
    const footer = pending ? (
        <span className="flex items-center gap-1.5">
            {waiting}
            <span className="shimmer">Waiting for approval</span>
        </span>
    ) : outcome?.approve ? (
        <span className="flex items-center gap-1.5 text-success">
            <CheckCircleIcon className="size-3.5" />
            Approved — implementing
        </span>
    ) : outcome ? (
        <span className="flex min-w-0 items-center gap-1.5">
            <ClipboardTextIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
                Kept planning{outcome.feedback ? ` — ${outcome.feedback}` : ""}
            </span>
        </span>
    ) : (
        "Not answered"
    );
    return (
        <div className={cn("overflow-hidden rounded-xl border bg-surface", pending ? "border-accent/40" : "border-border")}>
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs font-medium text-muted">
                <ClipboardTextIcon className="size-3.5" />
                Plan
            </div>
            <div className="max-h-96 overflow-y-auto px-4 py-3">
                <Markdown className="markdown-small">{plan || "_The plan is empty._"}</Markdown>
            </div>
            <div className="border-t border-border px-3 py-1.5 text-xs text-muted/90">{footer}</div>
        </div>
    );
}
