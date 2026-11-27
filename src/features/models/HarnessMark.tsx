import type { HarnessId } from "@/proto";
import { AntigravityMark } from "./AntigravityMark";
import { ClaudeMark } from "./ClaudeMark";
import { CodexMark } from "./CodexMark";

/** The mark of the CLI a chat runs on. */
export function HarnessMark({ harness, className }: { harness: HarnessId | undefined; className?: string }) {
    if (harness === "codex") return <CodexMark className={className} />;
    if (harness === "antigravity") return <AntigravityMark className={className} />;
    return <ClaudeMark className={className} />;
}
