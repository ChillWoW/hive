// Runs in every page a browser tab loads, before the page's own scripts
// (`src-tauri/src/browser.rs`). It keeps the page's console and failed
// requests for `browser_logs`, and holds what the browser tools call:
// `start`/`poll` run a job and hand its result back, since evaluating a
// script from outside can't wait for a promise.
(() => {
    if (window.__outcode) return;

    // ── Logs ────────────────────────────────────────────────────────────
    const MAX_LOGS = 500;
    const logs = [];
    let logSeq = 0;

    const show = (value) => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
        if (value instanceof Element) return describe(value);
        try {
            const text = JSON.stringify(value);
            return text === undefined ? String(value) : text;
        } catch {
            return String(value);
        }
    };

    const log = (level, text) => {
        logs.push({ n: ++logSeq, time: Date.now(), level, text: String(text).slice(0, 4000) });
        if (logs.length > MAX_LOGS) logs.shift();
    };

    for (const level of ["debug", "log", "info", "warn", "error"]) {
        const original = console[level];
        if (typeof original !== "function") continue;
        console[level] = function (...args) {
            try {
                log(level, args.map(show).join(" "));
            } catch {
                // Never break the page's own logging.
            }
            return original.apply(this, args);
        };
    }

    addEventListener(
        "error",
        (event) => {
            const target = event.target;
            if (target && target !== window && (target.src || target.href)) {
                log("error", `Failed to load ${target.tagName.toLowerCase()} ${target.src || target.href}`);
            } else if (event.message) {
                const at = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
                log("error", `Uncaught ${event.error?.stack || event.message}${at}`);
            }
        },
        true
    );
    addEventListener("unhandledrejection", (event) => log("error", `Unhandled rejection: ${show(event.reason)}`));

    const originalFetch = window.fetch;
    if (originalFetch) {
        window.fetch = function (input, init) {
            const method = (init?.method || input?.method || "GET").toUpperCase();
            const url = typeof input === "string" ? input : input?.url || String(input);
            const pending = originalFetch.apply(this, arguments);
            pending.then(
                (response) => {
                    if (!response.ok) log("network", `${method} ${url} → ${response.status} ${response.statusText}`);
                },
                (error) => log("network", `${method} ${url} failed: ${error?.message || error}`)
            );
            return pending;
        };
    }
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.addEventListener("loadend", () => {
            if (this.status === 0 || this.status >= 400) {
                log("network", `${String(method).toUpperCase()} ${url} → ${this.status || "failed"}`);
            }
        });
        return open.apply(this, arguments);
    };

    // ── Jobs ────────────────────────────────────────────────────────────
    const jobs = new Map();

    /** `value` as something JSON can carry. */
    const plain = (value, depth = 0, seen = new Set()) => {
        if (value === undefined || value === null) return null;
        const type = typeof value;
        if (type === "string" || type === "boolean") return value;
        if (type === "number") return Number.isFinite(value) ? value : String(value);
        if (type === "bigint" || type === "symbol") return String(value);
        if (type === "function") return `[function ${value.name || "anonymous"}]`;
        if (value instanceof Element) return describe(value);
        if (value instanceof Node) return `[${value.nodeName}]`;
        if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
        if (value instanceof Date) return value.toISOString();
        if (value === window) return "[window]";
        if (seen.has(value)) return "[circular]";
        if (depth > 8) return "[…]";
        seen.add(value);
        let out;
        if (Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection) {
            out = Array.from(value)
                .slice(0, 1000)
                .map((item) => plain(item, depth + 1, seen));
        } else if (value instanceof Map) {
            out = Object.fromEntries([...value].slice(0, 500).map(([k, v]) => [String(k), plain(v, depth + 1, seen)]));
        } else if (value instanceof Set) {
            out = [...value].slice(0, 1000).map((item) => plain(item, depth + 1, seen));
        } else {
            out = {};
            let count = 0;
            for (const key in value) {
                if (++count > 500) break;
                try {
                    out[key] = plain(value[key], depth + 1, seen);
                } catch (error) {
                    out[key] = `[${error}]`;
                }
            }
        }
        seen.delete(value);
        return out;
    };

    const start = (id, run) => {
        const job = { done: false };
        jobs.set(id, job);
        Promise.resolve()
            .then(run)
            .then(
                (value) => Object.assign(job, { done: true, ok: true, value: plain(value) }),
                (error) => Object.assign(job, { done: true, ok: false, error: String(error?.message || error) })
            );
        return "started";
    };

    /** A job's state as JSON; `null` once the page it started on is gone. */
    const poll = (id) => {
        const job = jobs.get(id);
        if (!job) return "null";
        if (job.done) jobs.delete(id);
        try {
            return JSON.stringify(job);
        } catch (error) {
            return JSON.stringify({ done: true, ok: false, error: `The result can't be sent: ${error}` });
        }
    };

    // ── Elements ────────────────────────────────────────────────────────
    const refs = new Map();
    const refIds = new WeakMap();
    let nextRef = 0;

    const refOf = (element) => {
        let id = refIds.get(element);
        if (!id) {
            id = `e${++nextRef}`;
            refIds.set(element, id);
            refs.set(id, new WeakRef(element));
        }
        return id;
    };

    /** The element a snapshot ref (`e12`) or a CSS selector names. */
    const find = (target) => {
        if (typeof target !== "string" || !target.trim()) throw new Error("Say which element: a ref from browser_snapshot or a CSS selector.");
        const text = target.trim();
        if (/^e\d+$/.test(text)) {
            const element = refs.get(text)?.deref();
            if (!element || !element.isConnected) {
                throw new Error(`Element ${text} isn't on the page anymore: take a new browser_snapshot.`);
            }
            return element;
        }
        let element;
        try {
            element = document.querySelector(text);
        } catch {
            throw new Error(`"${text}" isn't a ref or a valid CSS selector.`);
        }
        if (!element) throw new Error(`Nothing on the page matches "${text}".`);
        return element;
    };

    const clean = (text, max = 120) => {
        const line = String(text ?? "")
            .replace(/\s+/g, " ")
            .trim();
        return line.length > max ? `${line.slice(0, max - 1)}…` : line;
    };

    const isHidden = (element) => {
        if (element.getAttribute("aria-hidden") === "true" || element.hidden) return true;
        if (typeof element.checkVisibility === "function") {
            return !element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
        }
        const style = getComputedStyle(element);
        return style.display === "none" || style.visibility === "hidden";
    };

    const INPUT_ROLES = {
        button: "button",
        submit: "button",
        reset: "button",
        image: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        search: "searchbox",
        number: "spinbutton",
        file: "file input",
        hidden: null
    };
    const TAG_ROLES = {
        A: "link",
        BUTTON: "button",
        SUMMARY: "button",
        SELECT: "combobox",
        TEXTAREA: "textbox",
        OPTION: "option",
        H1: "heading",
        H2: "heading",
        H3: "heading",
        H4: "heading",
        H5: "heading",
        H6: "heading",
        IMG: "img",
        SVG: "img",
        NAV: "navigation",
        MAIN: "main",
        HEADER: "banner",
        FOOTER: "contentinfo",
        ASIDE: "complementary",
        FORM: "form",
        UL: "list",
        OL: "list",
        LI: "listitem",
        TABLE: "table",
        TR: "row",
        TD: "cell",
        TH: "columnheader",
        DIALOG: "dialog",
        IFRAME: "iframe",
        VIDEO: "video",
        AUDIO: "audio",
        CANVAS: "canvas",
        P: "paragraph",
        PRE: "code",
        BLOCKQUOTE: "blockquote"
    };

    const roleOf = (element) => {
        const explicit = element.getAttribute("role");
        if (explicit && explicit !== "presentation" && explicit !== "none") return explicit.split(" ")[0];
        const tag = element.tagName.toUpperCase();
        if (tag === "INPUT") {
            const type = (element.getAttribute("type") || "text").toLowerCase();
            return type in INPUT_ROLES ? INPUT_ROLES[type] : "textbox";
        }
        if (tag === "A") return element.hasAttribute("href") ? "link" : null;
        if (element.isContentEditable && !element.parentElement?.isContentEditable) return "textbox";
        return TAG_ROLES[tag] ?? null;
    };

    const INTERACTIVE = new Set([
        "link",
        "button",
        "textbox",
        "searchbox",
        "spinbutton",
        "checkbox",
        "radio",
        "slider",
        "combobox",
        "listbox",
        "option",
        "switch",
        "tab",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "treeitem",
        "file input"
    ]);
    /** Roles named by their own text: one line each, not walked into. */
    const NAMED_BY_TEXT = new Set(["link", "button", "heading", "option", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "treeitem"]);

    const isClickable = (element, role) => {
        if (INTERACTIVE.has(role)) return true;
        if (element.hasAttribute("onclick") || element.tabIndex >= 0) return true;
        // A handler on a plain element usually comes with a pointer cursor.
        if (getComputedStyle(element).cursor !== "pointer") return false;
        const parent = element.parentElement;
        return !parent || getComputedStyle(parent).cursor !== "pointer";
    };

    const labelOf = (element, role) => {
        const aria = element.getAttribute("aria-label");
        if (aria?.trim()) return clean(aria);
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
            const text = labelledBy
                .split(/\s+/)
                .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
                .join(" ");
            if (text.trim()) return clean(text);
        }
        const tag = element.tagName.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
            const label = element.labels?.[0]?.textContent;
            if (label?.trim()) return clean(label);
            if (role === "button") return clean(element.value || element.getAttribute("alt") || element.type);
            return clean(element.getAttribute("placeholder") || element.getAttribute("name") || element.getAttribute("title") || "");
        }
        if (tag === "IMG") return clean(element.getAttribute("alt") || element.getAttribute("title") || "");
        if (tag === "SVG") return clean(element.querySelector("title")?.textContent || element.getAttribute("title") || "");
        if (tag === "IFRAME") return clean(element.getAttribute("title") || element.getAttribute("name") || "");
        if (NAMED_BY_TEXT.has(role)) {
            return clean(element.innerText || element.textContent || element.getAttribute("title") || "");
        }
        return clean(element.getAttribute("title") || "");
    };

    /** A short name for an element, for results and errors. */
    function describe(element) {
        if (element === document.body || element === document.documentElement) return "the page";
        const known = roleOf(element);
        const role = known || element.tagName.toLowerCase();
        const name = labelOf(element, role) || clean(element.innerText || element.textContent || "", 60);
        if (name) return `${role} "${name}"`;
        return known ? `the ${known}` : `<${element.tagName.toLowerCase()}>`;
    }

    const stateOf = (element, role) => {
        const marks = [];
        const tag = element.tagName.toUpperCase();
        if (role === "heading") marks.push(`level=${element.getAttribute("aria-level") || tag.slice(1)}`);
        if (role === "checkbox" || role === "radio" || role === "switch") {
            const checked = tag === "INPUT" ? element.checked : element.getAttribute("aria-checked") === "true";
            if (checked) marks.push("checked");
        }
        if (element.disabled || element.getAttribute("aria-disabled") === "true") marks.push("disabled");
        if (element.getAttribute("aria-expanded")) marks.push(`expanded=${element.getAttribute("aria-expanded")}`);
        if (element.getAttribute("aria-selected") === "true" || (tag === "OPTION" && element.selected)) marks.push("selected");
        if (element.getAttribute("aria-current") && element.getAttribute("aria-current") !== "false") marks.push("current");
        if (tag === "INPUT" || tag === "TEXTAREA") {
            const type = (element.getAttribute("type") || "text").toLowerCase();
            if (type === "password") {
                if (element.value) marks.push('value="•••"');
            } else if (role !== "button" && role !== "checkbox" && role !== "radio" && element.value) {
                marks.push(`value=${JSON.stringify(clean(element.value, 80))}`);
            }
        } else if (tag === "SELECT") {
            const picked = element.selectedOptions?.[0];
            if (picked) marks.push(`value=${JSON.stringify(clean(picked.textContent, 80))}`);
        } else if (tag === "A" && element.href) {
            marks.push(`href=${JSON.stringify(clean(element.getAttribute("href"), 100))}`);
        }
        if (element === document.activeElement) marks.push("focused");
        return marks;
    };

    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "HR", "WBR", "PATH", "DEFS"]);
    const MAX_SNAPSHOT = 60000;

    const childrenOf = (element) => {
        if (element.shadowRoot) return element.shadowRoot.childNodes;
        if (element.tagName === "SLOT") {
            const assigned = element.assignedNodes({ flatten: true });
            if (assigned.length) return assigned;
        }
        return element.childNodes;
    };

    /** The page as an outline: one line per landmark, control and text, with a ref for each thing that can be acted on. */
    const snapshot = (selector) => {
        const root = selector ? find(selector) : document.body;
        if (!root) return "(the page has no body yet)";
        const lines = [];
        let size = 0;
        let dropped = 0;
        const emit = (depth, text) => {
            if (size > MAX_SNAPSHOT) {
                dropped++;
                return;
            }
            const line = `${"  ".repeat(depth)}- ${text}`;
            size += line.length + 1;
            lines.push(line);
        };

        const walk = (node, depth) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = clean(node.nodeValue, 300);
                if (text) emit(depth, `text: ${JSON.stringify(text)}`);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const tag = node.tagName.toUpperCase();
            if (SKIP.has(tag) || isHidden(node)) return;

            const role = roleOf(node);
            const clickable = isClickable(node, role);
            const shown = role ?? (clickable ? "clickable" : null);
            let next = depth;
            let descend = true;
            if (shown) {
                const name = labelOf(node, shown) || (shown === "clickable" ? clean(node.innerText || "", 80) : "");
                const parts = [shown];
                if (name) parts.push(JSON.stringify(name));
                if (clickable) parts.push(`[ref=${refOf(node)}]`);
                for (const mark of stateOf(node, shown)) parts.push(`[${mark}]`);
                // Text that names the element is already on its line.
                const named = NAMED_BY_TEXT.has(shown) || shown === "clickable";
                descend = !named && tag !== "SVG" && tag !== "SELECT" && tag !== "TEXTAREA";
                if (shown === "paragraph" || shown === "listitem" || shown === "cell" || shown === "columnheader" || shown === "code" || shown === "blockquote") {
                    // Plain text blocks read better as one line.
                    const interactive = node.querySelector("a[href],button,input,select,textarea,[role],[onclick],[tabindex]");
                    if (!interactive) {
                        const text = clean(node.innerText || node.textContent || "", 400);
                        if (!text) return;
                        emit(depth, `${shown}: ${JSON.stringify(text)}`);
                        return;
                    }
                }
                if (tag === "IFRAME") {
                    let inner = null;
                    try {
                        inner = node.contentDocument?.body ?? null;
                    } catch {
                        inner = null;
                    }
                    emit(depth, `${parts.join(" ")}${inner ? "" : ` (another site: ${clean(node.src || "", 100)})`}`);
                    if (inner) for (const child of inner.childNodes) walk(child, depth + 1);
                    return;
                }
                emit(depth, parts.join(" "));
                next = depth + 1;
                if (tag === "SELECT") {
                    for (const option of [...node.options].slice(0, 50)) {
                        emit(next, `option ${JSON.stringify(clean(option.textContent))}${option.selected ? " [selected]" : ""}`);
                    }
                }
            }
            if (!descend) return;
            for (const child of childrenOf(node)) walk(child, next);
        };

        walk(root, 0);
        if (dropped) lines.push(`… ${dropped} more lines left out: pass a selector to see part of the page.`);
        return lines.length ? lines.join("\n") : "(nothing visible on the page)";
    };

    // ── Actions ─────────────────────────────────────────────────────────
    const centerOf = (element) => {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
    };

    const click = (target, options = {}) => {
        const element = find(target);
        // Named now: the click may change what it says.
        const name = describe(element);
        if (element.disabled) throw new Error(`${name} is disabled.`);
        const { x, y, rect } = centerOf(element);
        if (!rect.width && !rect.height) throw new Error(`${name} has no size: it isn't visible.`);
        // What a real click there would hit: an inner node of it, usually.
        const top = element.ownerDocument.elementFromPoint(x, y);
        const hit = top && element.contains(top) ? top : element;
        const covered = top && !element.contains(top) && !top.contains(element) ? describe(top) : null;
        const button = options.button === "right" ? 2 : options.button === "middle" ? 1 : 0;
        const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button, buttons: 1 };
        const press = (detail) => {
            hit.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            hit.dispatchEvent(new MouseEvent("mousedown", { ...init, detail }));
            if (typeof element.focus === "function") element.focus({ preventScroll: true });
            hit.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            hit.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0, detail }));
            if (button === 2) hit.dispatchEvent(new MouseEvent("contextmenu", { ...init, buttons: 0 }));
            else if (button === 1) hit.dispatchEvent(new MouseEvent("auxclick", { ...init, buttons: 0, detail }));
            else hit.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail }));
        };
        press(1);
        if (options.double) {
            press(2);
            hit.dispatchEvent(new MouseEvent("dblclick", { ...init, buttons: 0, detail: 2 }));
        }
        return { did: `${options.double ? "Double-clicked" : button === 2 ? "Right-clicked" : "Clicked"} ${name}`, covered };
    };

    const hover = (target) => {
        const element = find(target);
        const { x, y } = centerOf(element);
        const hit = element.ownerDocument.elementFromPoint(x, y);
        const at = hit && element.contains(hit) ? hit : element;
        const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
        at.dispatchEvent(new PointerEvent("pointerover", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        at.dispatchEvent(new MouseEvent("mouseover", init));
        at.dispatchEvent(new PointerEvent("pointerenter", { ...init, bubbles: false, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        at.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }));
        at.dispatchEvent(new PointerEvent("pointermove", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        at.dispatchEvent(new MouseEvent("mousemove", init));
        return { did: `Hovered ${describe(element)}` };
    };

    /** Sets a field's value the way typing does, so frameworks that track it notice. */
    const setValue = (element, value) => {
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
    };

    const insertText = (element, text, replace) => {
        if (element instanceof HTMLSelectElement) {
            const want = text.trim().toLowerCase();
            const option = [...element.options].find((o) => o.value === text || o.textContent.trim().toLowerCase() === want);
            if (!option) throw new Error(`${describe(element)} has no option "${text}".`);
            setValue(element, option.value);
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return;
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element.disabled || element.readOnly) throw new Error(`${describe(element)} can't be edited.`);
            const type = (element.getAttribute("type") || "text").toLowerCase();
            if (type === "checkbox" || type === "radio" || type === "file") {
                throw new Error(`${describe(element)} isn't a text field: click it${type === "file" ? " or use browser_upload" : ""}.`);
            }
            element.focus({ preventScroll: true });
            setValue(element, replace ? text : element.value + text);
            element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return;
        }
        const editable = element.isContentEditable ? element : element.querySelector?.("[contenteditable=''],[contenteditable='true'],input,textarea");
        if (editable && editable !== element && !editable.isContentEditable) return insertText(editable, text, replace);
        if (!editable) throw new Error(`${describe(element)} isn't a field that takes text.`);
        editable.focus({ preventScroll: true });
        const selection = editable.ownerDocument.getSelection();
        const range = editable.ownerDocument.createRange();
        range.selectNodeContents(editable);
        if (!replace) range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!editable.ownerDocument.execCommand("insertText", false, text)) {
            if (replace) editable.textContent = text;
            else editable.append(text);
            editable.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
        }
    };

    const KEY_CODES = {
        Enter: 13,
        Tab: 9,
        Escape: 27,
        Backspace: 8,
        Delete: 46,
        " ": 32,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34
    };
    const KEY_NAMES = { esc: "Escape", return: "Enter", space: " ", spacebar: " ", del: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };

    const tabbable = (doc) =>
        [...doc.querySelectorAll("a[href],button,input,select,textarea,[tabindex],[contenteditable='true']")].filter(
            (el) => el.tabIndex >= 0 && !el.disabled && !isHidden(el)
        );

    /** Presses a key (`Enter`, `Control+A`, `Shift+Tab`) on an element, or on what has the focus. */
    const press = (combo, target) => {
        const parts = String(combo).split("+").map((p) => p.trim());
        let key = parts.pop() || "";
        // "Control++" and a lone "+".
        if (!key && String(combo).endsWith("+")) key = "+";
        key = KEY_NAMES[key.toLowerCase()] ?? key;
        const mods = new Set(parts.map((p) => p.toLowerCase()));
        const ctrlKey = mods.has("control") || mods.has("ctrl");
        const metaKey = mods.has("meta") || mods.has("cmd") || mods.has("command");
        const altKey = mods.has("alt") || mods.has("option");
        const shiftKey = mods.has("shift");
        const element = target ? find(target) : document.activeElement || document.body;
        if (target && typeof element.focus === "function") element.focus({ preventScroll: true });

        const printable = key.length === 1;
        const code = printable ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key === " " ? "Space" : "") : key;
        const keyCode = KEY_CODES[key] ?? (printable ? key.toUpperCase().charCodeAt(0) : 0);
        const init = { key, code, keyCode, which: keyCode, ctrlKey, metaKey, altKey, shiftKey, bubbles: true, cancelable: true, composed: true, view: window };
        const went = element.dispatchEvent(new KeyboardEvent("keydown", init));
        if (went && printable && !ctrlKey && !metaKey) element.dispatchEvent(new KeyboardEvent("keypress", init));

        // What the browser itself would do next, for the keys that matter most.
        if (went && !ctrlKey && !metaKey && !altKey) {
            const tag = element.tagName?.toUpperCase();
            const field = tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable;
            if (key === "Enter") {
                if (tag === "INPUT" && element.form) {
                    if (typeof element.form.requestSubmit === "function") element.form.requestSubmit();
                    else element.form.submit();
                } else if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || element.getAttribute?.("role") === "button") {
                    element.click();
                } else if (tag === "TEXTAREA" || element.isContentEditable) {
                    insertText(element, "\n", false);
                }
            } else if (key === " " && (tag === "BUTTON" || (tag === "INPUT" && ["checkbox", "radio", "button", "submit"].includes(element.type)))) {
                element.click();
            } else if (key === "Tab") {
                const order = tabbable(element.ownerDocument || document);
                const at = order.indexOf(element);
                const next = order[(at + (shiftKey ? -1 : 1) + order.length) % order.length];
                next?.focus();
            } else if (key === "Backspace" && (tag === "INPUT" || tag === "TEXTAREA")) {
                setValue(element, element.value.slice(0, -1));
                element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
            } else if (printable && field) {
                insertText(element, key, false);
            }
        }
        element.dispatchEvent(new KeyboardEvent("keyup", init));
        return { did: `Pressed ${combo} on ${describe(element)}` };
    };

    const type = (target, text, options = {}) => {
        const element = find(target);
        centerOf(element);
        insertText(element, String(text), !options.append);
        if (options.submit) press("Enter", target);
        return { did: `Typed into ${describe(element)}${options.submit ? " and pressed Enter" : ""}` };
    };

    const upload = (target, files) => {
        let element = find(target);
        if (!(element instanceof HTMLInputElement && element.type === "file")) {
            const inner = element.querySelector?.("input[type=file]") ?? (element instanceof HTMLLabelElement ? element.control : null);
            if (!(inner instanceof HTMLInputElement && inner.type === "file")) {
                throw new Error(`${describe(element)} isn't a file input (and has none inside).`);
            }
            element = inner;
        }
        if (files.length > 1 && !element.multiple) throw new Error("That file input takes one file.");
        const transfer = new DataTransfer();
        for (const file of files) {
            const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
            transfer.items.add(new File([bytes], file.name, { type: file.type || "application/octet-stream" }));
        }
        element.files = transfer.files;
        element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { did: `Set ${files.length} file${files.length === 1 ? "" : "s"} on ${describe(element)}` };
    };

    /** Whether what's waited for is there now (or gone, when `gone`). */
    const waiting = ({ text, selector, gone }) => {
        let there = true;
        if (selector) {
            const element = document.querySelector(selector);
            there = !!element && !isHidden(element);
        }
        if (there && text) there = (document.body?.innerText || "").includes(text);
        return gone ? !there : there;
    };

    const waitFor = async (what, timeoutMs) => {
        if (what.selector) document.querySelector(what.selector);
        const started = performance.now();
        for (;;) {
            if (waiting(what)) return { waitedMs: Math.round(performance.now() - started) };
            if (performance.now() - started > timeoutMs) throw new Error("timeout");
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    };

    const favicon = () => {
        const link = [...document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']")].find((l) => l.href);
        if (link) return link.href;
        return /^https?:$/.test(location.protocol) ? `${location.origin}/favicon.ico` : null;
    };

    const status = () => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        favicon: favicon(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
    });

    const readLogs = ({ levels, limit, clear } = {}) => {
        const wanted = levels?.length ? logs.filter((entry) => levels.includes(entry.level)) : logs;
        const out = wanted.slice(-(limit || 100));
        const total = wanted.length;
        if (clear) logs.length = 0;
        return { total, entries: out };
    };

    // ── Picking an element ──────────────────────────────────────────────
    const selectorOf = (element) => {
        const doc = element.ownerDocument;
        const unique = (selector) => {
            try {
                return doc.querySelectorAll(selector).length === 1;
            } catch {
                return false;
            }
        };
        if (element.id && unique(`#${CSS.escape(element.id)}`)) return `#${CSS.escape(element.id)}`;
        for (const attr of ["data-testid", "data-test", "data-cy", "name", "aria-label"]) {
            const value = element.getAttribute(attr);
            if (!value) continue;
            const selector = `${element.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
            if (unique(selector)) return selector;
        }
        const path = [];
        let node = element;
        while (node && node.nodeType === Node.ELEMENT_NODE && node !== doc.documentElement) {
            if (node.id && unique(`#${CSS.escape(node.id)}`)) {
                path.unshift(`#${CSS.escape(node.id)}`);
                break;
            }
            let part = node.tagName.toLowerCase();
            const parent = node.parentElement;
            if (parent) {
                const same = [...parent.children].filter((c) => c.tagName === node.tagName);
                if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
            }
            path.unshift(part);
            if (unique(path.join(" > "))) break;
            node = parent;
        }
        return path.join(" > ");
    };

    let picking = null;

    const cancelPick = () => picking?.finish(null);

    /** Lets the user click an element; resolves with what it is, or null when they back out (Escape). */
    const pick = () => {
        cancelPick();
        return new Promise((resolve) => {
            const box = document.createElement("div");
            box.style.cssText =
                "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4c9aff;background:rgba(76,154,255,.18);border-radius:3px;transition:all 60ms ease-out;display:none";
            const tag = document.createElement("div");
            tag.style.cssText =
                "position:fixed;z-index:2147483647;pointer-events:none;background:#1f2937;color:#f9fafb;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;padding:2px 6px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;display:none";
            document.documentElement.append(box, tag);
            let current = null;

            const outline = (element) => {
                current = element;
                const rect = element.getBoundingClientRect();
                Object.assign(box.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
                tag.textContent = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
                const below = rect.bottom + 22 < window.innerHeight;
                Object.assign(tag.style, { display: "block", left: `${Math.max(2, rect.left)}px`, top: `${below ? rect.bottom + 4 : Math.max(2, rect.top - 22)}px` });
            };
            const swallow = (event) => {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            };
            const onMove = (event) => {
                const element = document.elementFromPoint(event.clientX, event.clientY);
                if (element && element !== current && element !== box && element !== tag) outline(element);
            };
            const onClick = (event) => {
                swallow(event);
                const element = current ?? document.elementFromPoint(event.clientX, event.clientY);
                if (!element) return finish(null);
                const rect = element.getBoundingClientRect();
                finish({
                    selector: selectorOf(element),
                    tag: element.tagName.toLowerCase(),
                    text: clean(element.innerText || element.value || element.getAttribute("alt") || "", 200),
                    html: element.outerHTML.slice(0, 1500),
                    rect: {
                        x: rect.left + window.scrollX,
                        y: rect.top + window.scrollY,
                        width: rect.width,
                        height: rect.height
                    }
                });
            };
            const onKey = (event) => {
                swallow(event);
                if (event.key === "Escape") finish(null);
            };
            const events = [
                ["mousemove", onMove],
                ["click", onClick],
                ["mousedown", swallow],
                ["mouseup", swallow],
                ["pointerdown", swallow],
                ["pointerup", swallow],
                ["keydown", onKey]
            ];
            for (const [name, handler] of events) window.addEventListener(name, handler, true);
            const cursor = document.documentElement.style.cursor;
            document.documentElement.style.cursor = "crosshair";

            function finish(result) {
                if (picking?.finish !== finish) return;
                picking = null;
                for (const [name, handler] of events) window.removeEventListener(name, handler, true);
                document.documentElement.style.cursor = cursor;
                box.remove();
                tag.remove();
                // Two frames, so a screenshot taken next doesn't have the outline.
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
                // A hidden page paints no frames.
                setTimeout(() => resolve(result), 250);
            }
            picking = { finish };
        });
    };

    Object.defineProperty(window, "__outcode", {
        value: Object.freeze({ start, poll, find, snapshot, click, hover, type, press, upload, waitFor, status, favicon, logs: readLogs, pick, cancelPick }),
        enumerable: false
    });
})();
