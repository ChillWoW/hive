# hive

Repo: https://github.com/ChillWoW/hive (private) — licensed under GPL-3.0.

## What it is

A desktop UI for driving coding-agent CLIs (Claude Code, Codex, OpenCode, …) from one place.

- No provider APIs: Hive spawns the CLIs the user already has installed (e.g. `claude` with stream-json input/output, `codex app-server`) and talks to them over stdin/stdout.
- Each CLI's output is normalized into one common event stream: text, reasoning, tool calls/results, questions, done.
- The UI renders that stream as a live transcript.

## Stack

Desktop app "Hive": Tauri 2 shell (Rust, `src-tauri/`) around a React 19 + Vite + Tailwind v4 frontend (`src/`). Package manager is bun.

## Commands

- `bun run dev` — frontend only, Vite on http://localhost:1421
- `bun run dev:local` — Tauri dev with the dev config (`Hive Dev`, blue icon)
- `bun run dev:prod` — Tauri dev with the prod config
- `bun run build` — `tsc -b && vite build` into `build/`
- `bun run lint` — oxlint
- `bun run proto` — regenerates `src/proto/` (TS types) from `crates/proto`. Also runs on any `cargo test -p hive-proto`.
- `cargo run -p hive-harness --bin hive-run -- [--mock] [--model haiku] "<prompt>"` — drive a harness from the terminal and print its events (`--json` for raw `AgentEvent`s). Answers questions and follow-ups on stdin; Ctrl+C interrupts.
- `cargo test -p hive-harness --test claude_live -- --ignored --test-threads 1` — live tests against the real `claude` CLI on Haiku (spends tokens).
- `bun run icons` — regenerates `src-tauri/icons/{prod,dev}` and `public/favicon.svg` from `src-tauri/icons/icon.svg` / `icon.dev.svg`. Use this, not `tauri icon` directly (it pads the macOS `.icns`).

## Layout

- `src/main.tsx` — entry; renders `src/App.tsx` (shell: `src/layout/` sidebar + top bar, an overlay layer below the top bar that portalled overlays mount into, the settings modal).
- `src/ui/` — Base UI–based primitives (Button, Menu, Modal, Select, …), exported from `ui/index.ts`.
- `src/settings/` — settings UI and state. `store.ts`: zustand store (document, modal open/page), writes queued in order and optimistic; `useSetting(section, key)` gives a row its value, setter, `modified` and `reset`. `api.ts`: Tauri commands, localStorage fallback under plain `bun run dev`. `useSettingsRuntime` (mounted in `App`): loads, Mod+, toggles the modal, re-reads the file on window focus. Add a setting only once something reads it (field in `crates/proto/src/settings.rs`, row on a page in `pages/`). Pages live in `pages/` and are registered in `pages/index.tsx`; rows use `SettingsSection`/`SettingRow`, which self-filter for search.
- `src/chats/` — chat data layer. `api.ts`: engine commands, watches over `Channel`s (no backend under plain `bun run dev`: empty snapshots, writes reject). `store.ts`: zustand + immer store; `useChatsRuntime` (mounted in `App`) watches the chat list and sessions; `useChatMessages(chatId)` holds that chat's message watch while mounted (ref-counted `retainMessages`) and folds events with `foldEvent`. `send(target, prompt)` mints the user message id, shows the prompt from the outbox at once, creates the chat first for a `{ cwd, config }` target (and selects it), then queues a `send` command; the entry leaves the outbox when the saved message with that id arrives, or keeps the rejection as an error (`discard` drops it). `activeChatId` null is the new-chat view.
  Also `updateConfig` (optimistic, reverted if refused), `interrupt`, `answer`.
- `src/chat/ChatView.tsx` — the main pane: transcript + composer for the active chat; for the new-chat view a centred composer until the first prompt. While the live turn waits on an `input` part, `QuestionWizard` replaces the composer. Queued prompts (outbox `queued`) sit in a tray above the composer, not in the transcript.
- `src/projects/` — `store.ts`: the projects picked on this device (zustand, persisted to localStorage as `hive.projects`; `add` appends one, a listed one stays put; `remove` deletes one and remembers it in `removed`, so its chats don't bring it back until it's added again). `useProjects` lists them merged with every chat's folder in a fixed order (first seen first), so projects never move. The folder picker reads it, adds each pick, and has a "⋯" menu per row (Delete).
- `src/harnesses/` — harness catalogs (`list_harnesses`; a static fallback under `bun run dev`), fetched at launch and when a picker opens. `fitConfig` makes a `ChatConfig` valid for a catalog; `slashCommands` prefers the live `Session::commands`. Mock is only shown in dev builds.
- `src/composer/` — `Composer` (field beside the controls while it fits one line, else a two-row box, morphing between them as in Desktop/agent; one Send/Queue/Steer/Stop button; `/` command menu), `ModelPicker` (chip: harness mark, model, effort; card: provider tabs, search, starred models first, a Reasoning footer that opens the picked model's levels in a card beside it, as in Desktop/agent), `QuestionWizard`, `AccessPicker` beside the model picker (access mode + plan-mode switch, as in zeron), `FolderPicker` under the box (projects from `useProjects` with `ProjectIcon`: the folder's favicon via `folder_icon`, else a tinted monogram, as in zeron). New chats get `workspace-write`; the access mode is remembered, plan mode isn't. `store.ts`: drafts per chat; the new chat's folder + config and starred models persisted to localStorage.
- `src/transcript/` — `Transcript` (pins to the bottom while streaming, jump-to-bottom button), `UserMessage`, `AssistantMessage` (consecutive tool calls and thoughts → one `ToolGroup`: a muted "Thought process · Ran 3 commands · edited 2 files · 1 failed" header over a tree rail, one expandable line per item, open only while it's the tail of a running turn; subagent spawns as their own cards; text, questions and errors split groups — modelled on zeron's transcript), `Markdown` (Streamdown + Shiki via `@streamdown/code`; links open with the opener plugin), `diff.ts` (line diff for edits).
- `src/lib/cn.ts` — `cn()` (clsx + tailwind-merge) and `mergeClassName()`.
- `src/index.css` — Tailwind theme: `dark-*` / `primary-*` scales and `danger`/`success`/`warning`/`info` tokens.
- Cargo workspace at the root (`target/` there): `src-tauri/`, `crates/proto/`, `crates/harness/`, `crates/store/`, `crates/engine/`.
- `crates/proto/` (`hive-proto`) — wire types: `RunRequest`, `AgentEvent`, `ToolCall`, `MessagePart`/`Message`, `Chat`/`Session`, `Command` (the command ledger), `MessagesUpdate`/`ChatsUpdate` (what the engine's watchers stream). `fold_event` folds events into message parts. `Settings` (`settings.rs`): sections of plain leaves (`chats.resumeInterrupted`, read by the engine at launch); `Settings::sanitize` applies JSON leaf by leaf, keeping only leaves that still deserialize, then clamps. `bun run proto` also writes `src/proto/defaults.ts` (`DEFAULT_SETTINGS`) from `Settings::default()`. Source of truth; `src/proto/` is generated by ts-rs, never hand-edited.
- `src/transcript/fold.ts` — `foldEvent`: AgentEvent → MessagePart, in place on an immer draft. Mirrors the Rust `fold_event`; change both together.
- `crates/harness/` (`hive-harness`) — `Harness::catalog()` → `HarnessCatalog` (models with reasoning levels, built-in slash commands, `access_modes`, capabilities: `steering`, `interrupt`, `attachments`, `plan`; `installed` checked per call). `Harness::run(RunRequest)` → `Run { events, handle }`; `RunHandle` sends follow-ups, answers `InputRequested`, interrupts, closes. `mock.rs` is a scripted turn that honors the same handle. `claude/`: `wire.rs` (stream-json frames), `normalize.rs` (frames → `AgentEvent`), `mod.rs` (process + control channel: `initialize`, `can_use_tool`, `interrupt`). As in zeron, `RunRequest::access` (`AccessMode`: supervised / auto-accept edits / full access) decides which `can_use_tool` calls become yes/no approval questions (`approval.rs`); `AskUserQuestion` always does. `plan` launches in `--permission-mode plan` and re-enters it each turn; approving `ExitPlanMode` drops to the access mode. `auto_approve` adds the skip-permissions flags. The sandbox level doesn't reach Claude.
- `crates/store/` (`hive-store`) — durable state under one data dir: `hive.db` (SQLite, migrations in `MIGRATIONS`; chats, messages, commands as proto JSON plus query columns) and `journals/{chatId}.jsonl` (every event, tagged with its assistant message id). `start_turn` + `record` journal, fold and save a turn; `recover()` at boot expires pending commands and rebuilds streaming messages from their journals. `SettingsFile`: `settings.json` in the same dir (atomic writes; unreadable file moved to `settings.json.bak`).
- `crates/engine/` (`hive-engine`) — `Engine` runs chats over the store and harnesses. One live `Run` per chat, started on the first `Send` (resuming `harness_session_id`) and closed after `idle_timeout`. `queue_command` issues to the ledger, executes, settles; a `Send` mid-turn goes to the run and stays `pending` until its own turn starts (with the first non-subagent event after the previous `Done`). Every event goes through `store.record` and out to watchers under the chat's lock, so `watch_messages` (snapshot, then `MessagesUpdate`s) never overlaps or misses. `watch_chats` streams `ChatsUpdate`s (chats + live `Session`s, which carry the run's `AvailableCommands`). `catalogs()` lists harnesses in registration order. `update_config` saves a chat's `ChatConfig` and closes its run (now if idle, else after the turn) so the next prompt starts one with the new config, resuming the session. `start()` runs `recover()` and, with `resume_interrupted` (the `chats.resumeInterrupted` setting), resends cut-short turns as `RESUME_PROMPT`. Tests drive `MockHarness` (`tests/engine.rs`).
- `src-tauri/` — plugins: window-state, dialog (folder picker), opener (markdown links), log (debug only). Commands: `settings_*` (`src-tauri/src/settings.rs`; get/update/reset/reload/path/reveal, every change emitted as `settings://changed`); `create_chat`, `list_chats`, `list_harnesses`, `update_chat_config`, `folder_icon` (`src-tauri/src/folders.rs`: a project's favicon or app icon as a data URL), `queue_command`, `watch_messages`/`watch_chats` (stream over `Channel`s, return a watch id), `unwatch` (`src-tauri/src/engine.rs`; a webview's watchers are dropped when its page reloads). Registered harnesses: Claude Code and Mock. The main window is frameless (`decorations: false`; macOS overrides in `tauri.macos.conf.json`), so the frontend has to provide its own title bar.
- State: zustand + immer are installed.
- Path alias `@/` → `src/`.

## Conventions

- Commit messages follow Conventional Commits (`feat:`, `chore:`, `fix:`, …) with short subjects. Keep messages brief — a short subject line, body only when truly needed.
- Never add a `Co-Authored-By` trailer (or any other attribution footer) to commit messages.
- Never commit unless the user explicitly asks for it.
