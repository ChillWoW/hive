import { useActiveChat } from "@/features/chats/store";
import { HarnessMark } from "./HarnessMark";

/** The open chat's harness mark (its subagents and background agents run there too). */
export function ActiveHarnessMark({ className }: { className?: string }) {
    return <HarnessMark harness={useActiveChat()?.config.harness} className={className} />;
}
