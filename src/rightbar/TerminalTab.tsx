import { TerminalView } from "@/terminal";
import type { RightTab } from "./store";

/** A terminal in the right sidebar: just the shell (its exit is printed in it). */
export function TerminalTab({ tab }: { tab: Extract<RightTab, { kind: "terminal" }> }) {
    return <TerminalView id={tab.id} />;
}
