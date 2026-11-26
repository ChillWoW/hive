import type { FileRead } from "./DiffView";

/** A numbered line as the CLIs' read tools print it: Claude `   12→code` (or a tab), OpenCode `00012| code`. */
const NUMBERED = /^\s*(\d+)(?:→|\t|\| ?)(.*)$/;

/**
 * A read tool's output as the file's lines: the CLI's numbers and notes
 * stripped, its wrappers dropped. Numbered only when every line had a
 * number and they start at 1 (a read from an offset can't be shown at its
 * real numbers). Undefined when nothing is left to show.
 */
export function toFileRead(path: string, output: string): FileRead | undefined {
    let text = output.replace(/\r/g, "");
    const reminder = text.indexOf("<system-reminder>");
    if (reminder !== -1) text = text.slice(0, reminder);
    const raw = text
        .replace(/\n+$/, "")
        .split("\n")
        .filter((line) => !/^<\/?file>$/.test(line.trim()) && !/^\(End of file\b/.test(line.trim()));
    if (!raw.some((line) => line.trim())) return undefined;
    const matches = raw.map((line) => NUMBERED.exec(line));
    const numbered = matches.every((m) => m !== null);
    const lines = numbered ? matches.map((m) => m![2]!) : raw;
    return {
        file: { name: path.replace(/\\/g, "/"), contents: `${lines.join("\n")}\n` },
        numbered: numbered && Number(matches[0]![1]) === 1
    };
}
