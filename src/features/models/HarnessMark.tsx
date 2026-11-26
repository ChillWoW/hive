import type { HarnessId } from "@/proto";
import { ClaudeMark } from "./ClaudeMark";
import { CodexMark } from "./CodexMark";

/** The mark of the CLI a chat runs on. */
export function HarnessMark({ harness, className }: { harness: HarnessId | undefined; className?: string }) {
    return harness === "codex" ? <CodexMark className={className} /> : <ClaudeMark className={className} />;
}
