# Harness rebuild — task list

Work top to bottom. Each phase ends in something you can run. Check boxes as you go.
Gotchas (⚠) are things the current code learned the hard way — don't rediscover them.

---

## Phase 0 — Design for remote first

Decide before writing code, since remote connections change where the harness runs.

- [ ] Split into **host** (runs where the CLIs and the code are: local machine, SSH box, container) and **client** (UI). Harness + engine + store live on the host.
- [ ] Define one transport between them (JSON lines over WebSocket / stdio-over-SSH). Local = same protocol over an in-process or loopback channel. No Tauri-command-only paths.
- [ ] Every host call is: request/response, or a watch (snapshot then updates). Nothing else.
- [ ] Paths are host paths. The client never assumes it can read them (files, attachments, images go through the host).
- [ ] Auth for remote hosts (token per host), and a host id on every chat.

Done when: a one-page protocol sketch exists (commands, watches, error shape).

---

## Phase 1 — Wire types (`proto`)

- [ ] `HarnessId`, `AccessMode` (supervised / auto-accept edits / full access), `ReasoningLevel`.
- [ ] `Model` (id, label, reasoning levels, `ModelOption`s like fast mode / thinking on-off).
- [ ] `HarnessCatalog`: models, slash commands, access modes, capabilities (`steering`, `interrupt`, `attachments`, `plan`), `installed`.
- [ ] `RunRequest`: cwd, model, effort, options, access, plan, resume session id, attachments, MCP server, auto-compact window.
- [ ] `ToolCall` (normalized): Exec, ReadFile, WriteFile, EditFile, ApplyPatch, Search, Glob, WebFetch, WebSearch, Todo, Subagent (prompt, agent type), Mcp (server, tool, args), Unknown.
- [ ] `AgentEvent`: SessionStarted, TextDelta, ReasoningDelta, ToolCall, ToolResult, InputRequested, InputResolved, ContextUsage, Usage, AvailableCommands, Compaction (running/completed/failed/stopped, auto, pre/post tokens), BackgroundTasks (whole live set), GoalChanged, BackgroundTurn, Error, Subagent (nested event for a spawn id), Done (status).
- [ ] `UserInputQuestion` / `UserInputAnswer` (questions + yes/no approvals use the same shape).
- [ ] `MessagePart` / `Message` + `fold_event(parts, event)` (pure, no clock) and `stamp_event(parts, event, at)` for spawn start/end times.
- [ ] TS type generation (ts-rs) wired into tests, so frontend types never drift.

Done when: unit tests fold a scripted event list into the expected parts (text merge, tool call → result, nested subagent threads, compaction part).

---

## Phase 2 — Harness core

- [ ] `Harness` trait: `id()`, `catalog()`, `run(RunRequest) -> Run { events, handle }`, `commands(cwd)`, `supports_titles()`, `run_title()`.
- [ ] `RunHandle`: `send`, `send_with(attachments)`, `answer(request_id, answers)`, `interrupt`, `stop_task`, `task_output`, `close`. Commands over an unbounded channel; events over a bounded one (`emit` returns `Gone` when the receiver dropped → stop).
- [ ] **Process abstraction** (for remote): `spawn(program, args, env, cwd) -> {stdin, stdout, stderr, kill_tree}`. Local impl first; SSH/remote impl later plugs in here.
- [ ] `cli.rs`: `find(name)` on PATH then known install dirs; console hidden on Windows; `StderrTail` (last N lines for error messages); `kill_tree` (`taskkill /T` on Windows, process group on unix).
- [ ] `overrides`: custom binary, launch args (shell-split), extra env, config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) — applied to every spawn.
- [ ] `approval.rs`: given access mode + tool kind → allow / deny / ask as yes/no question. Plan-exit question.
- [ ] `attachments.rs`: list paths under the prompt; inline images where the CLI supports it.
- [ ] `models.rs`: `ModelCache` (TTL, background refresh), snapping a reasoning level to the closest the model has.
- [ ] **Mock harness**: scripted turn using the same handle (text, reasoning, tool calls, a question, a background task, interrupt). This is your test bed for everything above it.
- [ ] `outcode-run` CLI: drive any harness from the terminal, print events (`--json`), answer questions from stdin, Ctrl+C = interrupt.

Done when: `outcode-run --mock "hi"` streams a full turn, a question is answerable, Ctrl+C interrupts.

---

## Phase 3 — Claude Code

- [ ] Spawn `claude` with stream-json in/out, `--settings` JSON (fastMode, autoCompactWindow), `--mcp-config` inline.
- [ ] `wire.rs`: frame types. `normalize.rs`: frames → `AgentEvent` (text/reasoning deltas, tool_use → `ToolCall`, tool_result, usage, subagent traffic by parent tool id).
- [ ] Control channel: `initialize` (set `perTaskStopAffordance`), `can_use_tool` → approval via access mode, `interrupt`, `stop_task`, `get_task_output`, `get_context_usage`.
- [ ] First prompt waits for `initialize`'s answer.
- [ ] `AskUserQuestion` always becomes `InputRequested`.
- [ ] Plan mode: `--permission-mode plan`, re-enter each turn; approving `ExitPlanMode` drops to the access mode.
- [ ] Background tasks: `background_tasks_changed` → `BackgroundTasks`; CLI-started turn (`system:init` with no prompt in flight) → `BackgroundTurn` naming tasks from `task_notification`s.
- [ ] Compaction: `status: compacting` → running, `compact_boundary` → completed, failed `compact_result` → failed; "Not enough messages to compact." = failed.
- [ ] Turn with no streamed text → show `result` text (local commands like `/context`, `/cost`).
- [ ] Commands/skills: from `system:init`; `$skill` → `/name`.
- [ ] Resume via session id.
- [ ] ⚠ **OAuth refresh lock**: never kill/close a Claude process while `.oauth_refresh.lock` (or legacy `<config>.lock`) is live — the refresh token is single-use and you'll log the user out.
- [ ] ⚠ Skip `get_context_usage` window when `autocompactSource == settings` (that's the compaction window, not the model's).
- [ ] `run_title`: one turn, no tools/MCP/settings, no initialize.
- [ ] Live tests on Haiku (`--ignored`).

---

## Phase 4 — Codex

- [ ] `codex app-server` over JSON-RPC lines (`rpc.rs`; no `jsonrpc` field).
- [ ] ⚠ Serialize + retry server startups: servers starting together race on `$CODEX_HOME`'s SQLite and one dies.
- [ ] One server + one thread per run: `thread/start` or `thread/resume` (fallback: new thread + note).
- [ ] `turn/start` per prompt; a prompt mid-turn waits.
- [ ] Slash routing: `/compact` → `thread/compact/start`, `/review` → `review/start`, `/feedback` → `feedback/upload`, `/goal …` → `thread/goal/*`.
- [ ] Goals: read at open, follow `thread/goal/updated|cleared` → `GoalChanged`; after a turn wait 5s for Codex's next turn toward an active goal; later ones → `BackgroundTurn`; Stop pauses it.
- [ ] `normalize.rs`: agent messages/plans → text, reasoning summaries, commands (strip shell wrapper; lone read/search → ReadFile/Search), file changes (one call per file, old/new from hunks), MCP, web search, `turn/plan/updated` → Todo, token usage → ContextUsage, spawned agent threads → Subagent.
- [ ] Access: full = `approvalPolicy: never`, else `untrusted` + answer approvals by mode or ask; `item/tool/requestUserInput` asked as is.
- [ ] Plan mode = `plan` collaboration mode every turn; plan ending → ask to implement → "Implement the plan." in default mode.
- [ ] MCP via `mcp_servers.outcode.*` config overrides, `default_tools_approval_mode = approve`, `tool_timeout_sec`.
- [ ] Models: `model/list` (cache 10 min), fallback `models_cache.json`.
- [ ] `$skill` → `skill` input; images → `localImage`.

---

## Phase 5 — OpenCode (2.x)

- [ ] `opencode serve` on a free loopback port, per-run Basic password, ready on `/api/info`; refuse old servers with an update hint.
- [ ] ⚠ The launcher (bun shim) starts the real server → shut down the whole tree, never `kill_on_drop`.
- [ ] Session: `POST /api/session` (folder, model + variant, permission rules); resume = `PATCH` rules + `.../model`.
- [ ] SSE bus `GET /api/event` (all sessions' frames); filter to yours; turn ends on root `session.execution.succeeded|interrupted|failed`.
- [ ] `normalize.rs`: deltas, `session.tool.*` (`shell`, `subagent`; hide `question`), `session.compaction.*`, step tokens, child sessions → Subagent.
- [ ] Access: `ask` rules for shell/execute/web (+ edit in supervised, not on `plan` agent); `permission.asked` → mode or yes/no (`reject` with message else whole turn stops).
- [ ] `form.created` → question → `.../form/{id}/reply`.
- [ ] Plan = `plan` agent → ask to implement → `build`.
- [ ] `/command` → `.../command`, `/compact` → `.../compact`, `$skill` → `skills`, images → `files`.
- [ ] MCP via `OPENCODE_CONFIG_CONTENT` (merge with inherited), ⚠ `codemode: false` or tools hide.
- [ ] Models `/api/model` + `/api/provider` + `/api/model/default`; titles via `/api/experimental/generate/text`.

---

## Phase 6 — Pi

- [ ] `pi --mode rpc`, JSONL. Startup: `set_model`, `set_thinking_level`, `get_state`, `get_commands`; first prompt waits for `get_state`. Resume = `--session-id`.
- [ ] Prompt ends at `agent_settled` (or its response when `handled`); self-started runs → `BackgroundTurn`. Stop = `abort`; `/compact` → `compact`; `$skill` → `/skill:name`.
- [ ] ⚠ Windows shim is cmd → node → node: stop with `kill_tree`.
- [ ] `extension.mjs` (temp file, `-e`): `tool_call` hook asks via `confirm` titled `outcode:approval` (call as JSON) → approval question; launches the MCP bridge, registers `mcp__outcode__<tool>`.
- [ ] Other extension dialogs (`select`/`confirm`/`input`/`editor`) → questions; `notify` warn/error → Error.
- [ ] Models `get_available_models`, thinking off/on option. No plan mode.

---

## Phase 7 — Provider management (per harness)

- [ ] `status`: version (`--version`), login state, install location.
- [ ] `install` / `update` / `sign_out`; sign-in flow (`start` → `finish(code)`; Claude's fallback code paste; Codex's `account/login/start` without a code).
- [ ] Plan usage: Claude `GET /api/oauth/usage` with the CLI's token (read, never refresh), ⚠ User-Agent must be `claude-code/<installed version>` or 429; Codex `account/rateLimits/read`.
- [ ] Latest-release check (npm dist-tag).
- [ ] On remote hosts these run on the host — keep them behind the same protocol.

---

## Phase 8 — Store + engine (what drives harnesses)

- [ ] Store: SQLite (chats, messages, command ledger) + per-chat JSONL journal of every event. `start_turn` / `record` journal → fold → save.
- [ ] `recover()` at boot: expire pending commands, rebuild streaming messages from journals.
- [ ] Engine: one live `Run` per chat, started on first Send (resume session id), closed after idle timeout (never while background tasks run).
- [ ] Command ledger: `queue_command` → execute → settle. Send mid-turn queues in the engine; held after a user stop until next turn ends. `cancel_queued`, `reorder_queue`, `send_queued_now`.
- [ ] Every event recorded and published under the chat's lock → `watch_messages` (snapshot then updates, no gaps/overlap) and `watch_chats` (chats + live `Session`s).
- [ ] Session state not recorded: `BackgroundTasks`, `GoalChanged`, `activity`, secret requests.
- [ ] `BackgroundTurn` with no turn in flight → a reply with no prompt.
- [ ] Keep up to 8 replaced turns alive while their background subagents still report.
- [ ] `update_config`: save, close run (now or after the turn), next prompt resumes with new config.
- [ ] Titles (background title run, fallback first words), handoff summaries, branch names — all through `run_title`.
- [ ] Turn snapshots (git tree per prompted turn) → `turn_diff`, `revert_turn`.
- [ ] `shutdown(grace)`: interrupt + close all runs; next start recovers and optionally resumes.
- [ ] Engine tests on the mock harness.

---

## Phase 9 — Outcode MCP server

- [ ] Host: loopback TCP, one JSON line per call, token file.
- [ ] Bridge: the app's own exe as `outcode mcp` (stdio MCP: initialize, ping, tools/list, tools/call), tagged with `OUTCODE_CHAT_ID`.
- [ ] Injected per harness (see phases 3–6); tool timeout ~65 min on every CLI.
- [ ] Tools: whoami, request_secret, show_image, show_svg, preview_html, render_html.
- [ ] Remote: the bridge must reach the host, not the client — runs on the host side.

---

## Phase 10 — Remote connections (new)

- [ ] Host daemon binary: engine + store + harnesses + MCP host, serving the Phase 0 protocol.
- [ ] Client connects to N hosts; chat list merges them, each chat tagged with its host.
- [ ] SSH bootstrap: copy/start the daemon on a remote box, tunnel the socket.
- [ ] Reconnect: re-open watches from snapshot; turns keep running on the host while disconnected.
- [ ] File/terminal/git/attachments go through the host connection.
- [ ] Live tests: run the CLI tests (phases 3–6) against a remote host.

---

## Test checklist per harness (repeat for each)

- [ ] Plain prompt → text + Done
- [ ] Tool call → normalized ToolCall + result
- [ ] Approval asked in supervised, skipped in full access
- [ ] Question answered
- [ ] Interrupt mid-turn
- [ ] Follow-up while busy (queue / steer)
- [ ] Resume a previous session
- [ ] Compaction
- [ ] Subagent events nest correctly
- [ ] Background task survives turn end, can be stopped
- [ ] Outcode MCP tool call (and a long wait > CLI's default timeout)
- [ ] Attachments (file + image)
- [ ] Title run
