# outcode

Repo: https://github.com/ChillWoW/outcode — licensed under GPL-3.0.

## What it is

A desktop UI for driving coding-agent CLIs (Claude Code, Codex, OpenCode, …) from one place.

- No provider APIs: Outcode spawns the CLIs the user already has installed (e.g. `claude` with stream-json input/output, `codex app-server`) and talks to them over stdin/stdout.
- Each CLI's output is normalized into one common event stream: text, reasoning, tool calls/results, questions, done.
- The UI renders that stream as a live transcript.

## Status

Branch `rework/app` is a from-scratch rebuild: app shell, settings, themes, fonts, keybindings, updater, toasts, UI kit, terminal tabs, and chats driven by the Claude Code and Codex harnesses.

## Stack

- Tauri 2 (Rust, `src-tauri/`, Cargo workspace at the root) + React 19 / TypeScript / Vite 8, React Compiler, Tailwind 4, Zustand, Base UI, Phosphor icons.
- Package manager: bun. Lint: `bun run lint` (oxlint). Typecheck/build: `bun run build`.
- `@/` aliases `src/`.

## Commands

- `bun run dev:local` — run the app with the dev config (`com.outcode.dev`, "Outcode Dev", data in `~/.outcode.dev`).
- `bun run dev:prod` — run with the prod config (data in `~/.outcode`).
- `bun run dev` — Vite only, no backend; `backend()` calls reject unless given a dev fallback.
- `bun run release <version>` then `git push --follow-tags` — bumps package.json / tauri.conf.json / Cargo.toml, tags `v*`; `.github/workflows/release.yml` builds and publishes the release the updater reads.

## Layout

- `src/features/<name>/` — feature modules (settings, theme, fonts, updater, git). Each mounts a `use*Runtime()` hook in `App.tsx`.
- `src/layout/` — app chrome (TopBar, Sidebar, WindowControls).
- `src/ui/` — shared UI kit (from the `vite-template` repo); reuse these before writing new primitives. Compound components: sub-parts hang off the root (`Modal.Content`, `Menu.Item`, `Input.Group`); sizes share one scale (`xs`–`xl`, 28–44px). Hooks live in their own `use*.ts`. The app is wrapped in `Tooltip.Provider` and `ModalStack` (`useModalStack()`) in `main.tsx`.
- `src/keybindings/` — action registry (`actions.ts`) + runtime; bindings live in settings.
- `src/lib/backend.ts` — use `backend(command, args, devFallback?)` instead of raw `invoke`.
- `src-tauri/src/` — Tauri commands, registered in `lib.rs`: `chat.rs` (engine commands, watchers), `folders.rs`, `git.rs`, `files.rs`, `file_watch.rs` (tells the page when a folder's files change), `search.rs` (text search across a folder's files), `editor.rs` (file tabs: read, save with conflict checks), `terminal.rs`, `browser.rs` (browser tabs, below), `mcp.rs` + `mcp/` (the tools agents get from Outcode's own MCP server, hosted by `crates/mcp`), `settings/`, `themes.rs`, `fonts.rs`, `updater.rs`, `http.rs`.
- `crates/proto` — wire types; `cargo test -p outcode-proto` regenerates `src/proto/` (never edit by hand).
- `crates/harness` — spawns agent CLIs, normalizes output to `AgentEvent`s; each CLI is a `Harness` (`claude::Claude`, `codex::Codex`; `mock::Mock` behind feature `mock` for engine tests), picked per chat by `ChatConfig.harness`. Live tests: `cargo test -p outcode-harness -- --ignored`.
- `crates/git` — a folder's branches over the user's `git` CLI (list, switch, create, delete), chats' worktrees (add, restore, remove), and turn snapshots (`turn.rs`: the checkout written as a tree into a private object store under `<data dir>/turn-snapshots`, never into the user's repo; a turn's changes are that against the checkout now, and undo writes it back).
- `crates/terminal` — the user's shell in a pty (portable-pty) for terminal tabs: batched output, hangup on close, the foreground program for tab titles. Frontend in `src/features/terminal/` (xterm.js).
- `crates/store` — SQLite (`outcode.db`: chats, messages) + per-chat JSONL event journals; `recover()` closes turns a crash left open.
- `crates/engine` — chats and their live runs over the store: one run per chat, resumed by session id, closed when idle; `watch_chats` / `watch_messages` stream a snapshot then changes. Each prompted turn snapshots the chat's checkout (in memory, latest turn only, gone on restart): `turn_changes` / `revert_turn`, shown in the latest reply's footer and a "Last turn" diff tab (`src/features/changes/turn.ts`).

## Browser tabs

Web pages in the tabs panel, shared by the user and their agents (the `browser_*` MCP tools in `src-tauri/src/mcp/browser.rs`).

- Each tab is a native child webview of the main window (Tauri's `unstable` feature), owned by `src-tauri/src/browser.rs`; the page mirrors them as `browser` panel tabs (`src/features/browser/`). One profile for all of them, in `<data dir>/browser`.
- A native webview draws above the page and isn't clipped by it. `src/features/browser/placement.ts` keeps it over its frame and swaps it for a still picture while a menu, dialog or tooltip overlaps it, or a panel slides or resizes. So nothing in the page can be drawn over a live tab: toolbar tooltips open upward for that reason.
- Pages can't call into Outcode: `capabilities/default.json` names the `main` webview, not the window, and a tab won't load Outcode's own origin. Everything is asked of a page by evaluating script against the helpers `src-tauri/src/browser/inject.js` leaves in it (snapshot, click, type, logs, …); `Browsers::js` runs a job there and polls for its result.
- Tauri plugins' init scripts run in tabs' pages too. The opener plugin's link-click handler is off for that reason (`lib.rs`): the page opens its own links with `openLink` (`src/features/browser/open.ts`), local ones in a browser tab.
- **Windows only so far, to do on macOS** (`src-tauri/src/browser/native.rs`, the `not(windows)` half): screenshots (`WKWebView.takeSnapshot`; without them `browser_screenshot`, the toolbar's screenshot and a picked element's picture are refused, and a covered tab goes blank instead of still), history state (`canGoBack` / `canGoForward`; Back and Forward are always enabled meanwhile), the app's shortcuts pressed inside a page (`watch_keys`: WebView2's accelerator keys here; without it Close tab and the rest don't fire while a page has the keyboard), and DevTools in release builds (needs Tauri's `devtools` feature). The rest is cross-platform but has only been run on Windows: check child webview placement (`browser_place` takes physical pixels) and the page-size zoom there too.

## Conventions

- Settings: `src-tauri/src/settings/schema.rs` is the source of truth, mirrored in `src/features/settings/types.ts` — change both together. Add a setting only once something reads it; keep sections to plain leaves.
- Themes: built-ins in `src/features/theme/themes.ts`; user themes are JSON files in `<data dir>/themes/` (files starting with `_` are skipped).
- Commit messages follow Conventional Commits (`feat:`, `chore:`, `fix:`, …) with short subjects. Keep messages brief — a short subject line, body only when truly needed.
- Never add a `Co-Authored-By` trailer (or any other attribution footer) to commit messages.
- Never commit unless the user explicitly asks for it.
