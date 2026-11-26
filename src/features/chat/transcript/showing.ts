import type { ToolPart } from "../fold";

/** Outcode's own tools that show something in the chat, by name. */
const SHOWING = new Set(["show_image", "show_svg", "render_html"]);

/** Whether `part` is a call of Outcode's own that shows something where it is. */
export function isShowing(part: ToolPart): boolean {
    return part.call.kind === "mcp" && part.call.server === "outcode" && SHOWING.has(part.call.tool);
}
