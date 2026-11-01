import { ArchiveIcon, NotePencilIcon, QuestionIcon, KeyIcon } from "@phosphor-icons/react";
import type { Session } from "@/proto";
import { ThoughtIcon } from "./ThoughtIcon";
import { chipContent, iconOf, pathOf, shortPath, type ToolIcon } from "./tools";

/** One line about what a live agent is doing: "Run  cargo test". */
export type ActivityLine = { icon: ToolIcon | null; label: string; detail: string };

/**
 * What a chat's agent is doing now, from its session (`Session.activity`,
 * kept current by the engine): waiting on the user, a tool call (labelled
 * as in the transcript), thinking (its latest heading), writing,
 * compacting. Null between turns.
 */
export function describeActivity(
    session: Session | undefined,
    cwd: string | undefined
): ActivityLine | null {
    if (!session) return null;
    if (session.status === "awaitingInput") {
        return session.secrets?.length
            ? { icon: KeyIcon, label: "Needs a secret", detail: session.secrets[0]!.label }
            : { icon: QuestionIcon, label: "Waiting for your answer", detail: "" };
    }
    if (session.status !== "working") return null;
    const activity = session.activity;
    switch (activity?.kind) {
        case "thinking":
            return { icon: ThoughtIcon, label: "Thinking", detail: activity.heading ?? "" };
        case "writing":
            return { icon: NotePencilIcon, label: "Writing", detail: "" };
        case "compacting":
            return { icon: ArchiveIcon, label: "Compacting context", detail: "" };
        case "tool": {
            const { call } = activity;
            const { label, detail } = chipContent(call, cwd);
            const path = pathOf(call);
            return {
                icon: iconOf(call),
                label,
                detail: path ? shortPath(path, cwd) : detail
            };
        }
        default:
            return { icon: null, label: "Working", detail: "" };
    }
}
