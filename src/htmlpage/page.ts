/**
 * Pages agents show with Hive's `render_html` tool (`src-tauri/src/html.rs`,
 * as t3code's `html_render`). A page runs in an iframe from `srcdoc` with
 * `sandbox="allow-scripts allow-forms"` and never `allow-same-origin`: its
 * origin is opaque, so its scripts run but can't reach Hive, its IPC or its
 * storage. What the host needs from it comes over `postMessage` from the
 * bootstrap below: its height, console output and errors, link clicks.
 */

/** The iframe's sandbox: scripts and forms, nothing that reaches out of the frame. */
export const PAGE_SANDBOX = "allow-scripts allow-forms";

/** What a page tells the host. */
export type PageMessage =
    | { type: "size"; height: number }
    | { type: "console"; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
    | { type: "loaded"; text: string }
    | { type: "link"; url: string };

// Runs first in every page. No `</script>` may appear in it.
const BOOTSTRAP = `(() => {
  const post = (m) => { try { parent.postMessage(Object.assign({ __hivePage: 1 }, m), "*"); } catch {} };
  const show = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = (...args) => {
      post({ type: "console", level, text: args.map(show).join(" ").slice(0, 2000) });
      original.apply(console, args);
    };
  }
  addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      post({ type: "console", level: "error", text: "Failed to load " + (t.src || t.href) });
    } else {
      const what = e.error && e.error.stack ? e.error.stack : e.message;
      post({ type: "console", level: "error", text: "Uncaught " + what + (e.lineno ? " (line " + e.lineno + ")" : "") });
    }
  }, true);
  addEventListener("unhandledrejection", (e) => {
    post({ type: "console", level: "error", text: "Unhandled rejection: " + show(e.reason) });
  });
  let last = -1;
  const report = () => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height !== last) { last = height; post({ type: "size", height }); }
  };
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener("DOMContentLoaded", report);
  addEventListener("load", () => {
    report();
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    fonts.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      report();
      post({ type: "loaded", text: (document.body ? document.body.innerText : "").slice(0, 1500) });
    })));
  });
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    let url;
    try { url = new URL(href, document.baseURI); } catch { return; }
    if (!/^(https?|mailto):$/.test(url.protocol)) return;
    e.preventDefault();
    post({ type: "link", url: url.href });
  });
})();`;

const BOOTSTRAP_TAG = `<script>${BOOTSTRAP}</script>`;

/**
 * The page with the bootstrap first: after Hive's theme (which `render_html`
 * puts at the start of the head), else at the start of the head, else after
 * the doctype, keeping the page out of quirks mode.
 */
export function pageDocument(html: string): string {
    const lower = html.toLowerCase();
    const theme = lower.indexOf('<style id="hive-theme">');
    let at = -1;
    if (theme !== -1) {
        const end = lower.indexOf("</style>", theme);
        if (end !== -1) at = end + "</style>".length;
    }
    for (const tag of ["<head", "<!doctype"]) {
        if (at !== -1) break;
        const start = lower.indexOf(tag);
        const end = start === -1 ? -1 : lower.indexOf(">", start);
        if (end !== -1) at = end + 1;
    }
    return at === -1
        ? `<!doctype html>${BOOTSTRAP_TAG}${html}`
        : html.slice(0, at) + BOOTSTRAP_TAG + html.slice(at);
}

/** The message if it came from `frame`'s page. */
export function readMessage(
    event: MessageEvent,
    frame: HTMLIFrameElement | null
): PageMessage | undefined {
    if (!frame || event.source !== frame.contentWindow) return undefined;
    const data: unknown = event.data;
    if (!data || typeof data !== "object" || !("__hivePage" in data)) return undefined;
    return data as unknown as PageMessage;
}
