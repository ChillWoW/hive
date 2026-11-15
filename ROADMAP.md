# Roadmap

Built from scratch, Claude Code first, one feature at a time. Each step is a vertical slice
(backend + UI + its settings) and ends in something you can run. Tick boxes as you go.

Rules for every step:
- Add settings only when the step reads them (`schema.rs` + `types.ts` together).
- Frontend talks to chats through one module (`src/features/chat/api.ts`), never raw `backend()`
  calls from components — that's the seam a remote host can slot into later.
- ⚠ marks things the old code learned the hard way.
- The old Hive app lives on the `main` branch — read it for reference before building a step
  (`git show main:<path>`, e.g. `crates/harness/src/claude/`, `crates/proto/`, `crates/engine/`,
  `crates/store/`, `src-tauri/src/engine.rs`). Learn from it, don't copy it wholesale.

---

## 1. Hello Claude

- [x] `crates/proto`: `AgentEvent` (`TextDelta`, `Done`, `Error`), `RunRequest` (cwd, prompt). ts-rs → `src/proto/`.
- [x] `crates/harness`: `cli::find("claude")` (PATH + known install dirs), hidden console on Windows, `StderrTail`.
- [x] Spawn `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`; text deltas → `TextDelta`, `result` → `Done`.
- [x] Tauri: `chat_send(prompt, cwd)` streams events via `app.emit`.
- [x] UI: one chat view, composer, basic markdown transcript (Streamdown, no highlighting yet).
- [x] Settings: `claude.binaryPath` (optional override).

Done when: typing "hi" streams Claude's reply.

## 2. Multi-turn + stop

- [x] Keep the process alive between prompts (`RunHandle::send`, `close`).
- [x] Control channel: `initialize`; first prompt waits for its answer. `interrupt`.
- [x] `kill_tree` (`taskkill /T` on Windows, process group on unix).
- [x] ⚠ **OAuth refresh lock**: never kill/close Claude while `.oauth_refresh.lock` (or legacy `<config>.lock`) is live — the refresh token is single-use and the user gets logged out.
- [x] UI: Stop button (Esc), busy state.

## 3. Rich transcript

- [x] `ReasoningDelta`, `ToolCall` (normalized: Exec, ReadFile, WriteFile, EditFile, Search, Glob, WebFetch, WebSearch, Todo, Unknown), `ToolResult`.
- [x] `Message` / `MessagePart` + pure `fold_event` (unit tests on scripted events).
- [x] UI: markdown, code blocks (no highlighting yet), reasoning block, tool cards (diff for edits, output for exec), todo list. Tool rows grouped (consecutive edits on one line), thoughts with a preview line, long prompts collapse, file + web links clickable.
- [x] Turn with no streamed text → show `result` text.
- [ ] Settings: `chat.reasoningExpanded`, `chat.toolOutputExpanded`.

## 4. Chats + projects + persistence

- [x] `crates/store`: SQLite (chats, messages) + per-chat JSONL event journal. Projects live in localStorage for now.
- [x] Session id from `system:init`; resume with `--resume <id>`.
- [x] Engine (minimal): one live run per chat, started on first send, closed after idle timeout.
- [x] `watch_chats` / `watch_messages` (snapshot then updates).
- [x] UI: sidebar project + chat list, new chat, open folder, rename/delete.
- [x] `recover()` at boot: rebuild half-streamed messages from journals.
- [x] Settings: `chat.idleTimeoutMinutes`.

## 5. Models + effort

- [ ] `Model` (id, label, reasoning levels, options like fast mode), `HarnessCatalog`.
- [ ] Pass `--model`, effort, `--settings` JSON (fastMode).
- [ ] Changing model mid-chat: close run, next prompt resumes with new config.
- [ ] UI: model/effort picker in composer.
- [ ] Settings: `claude.defaultModel`, `claude.defaultEffort`, `claude.fastMode`.

## 6. Access modes + approvals

- [ ] `AccessMode`: supervised / auto-accept edits / full access.
- [ ] `can_use_tool` → allow / deny / ask (`InputRequested` yes/no) by mode.
- [ ] UI: approval card (allow / deny / allow for session), access picker.
- [ ] Settings: `claude.defaultAccess`.

## 7. Questions

- [ ] `UserInputQuestion` / `UserInputAnswer` (same shape as approvals).
- [ ] `AskUserQuestion` always → `InputRequested`; answer → `InputResolved`.
- [ ] UI: question card (options, multi-select, free text).

## 8. Follow-ups while busy

- [ ] Command ledger: send mid-turn queues; cancel / reorder / send-now.
- [ ] Held after a user stop until the next turn ends.
- [ ] UI: queued prompts above composer.
- [ ] Settings: `chat.busySend` (queue / steer).

## 9. Plan mode

- [ ] `--permission-mode plan`, re-enter each turn; approving `ExitPlanMode` drops to the access mode.
- [ ] UI: plan toggle, plan card with approve / keep planning.

## 10. Slash commands + skills

- [ ] Commands/skills from `system:init` → `AvailableCommands`; `$skill` → `/name`.
- [ ] UI: `/` autocomplete in composer.

## 11. Attachments

- [ ] Files: list paths under the prompt. Images: inline as image blocks.
- [ ] UI: paste/drop, chips, image previews.

## 12. Context + compaction

- [ ] `get_context_usage` → `ContextUsage`; `Usage` per turn.
- [ ] ⚠ Skip the window from `get_context_usage` when `autocompactSource == settings` (that's the compaction window, not the model's).
- [ ] Compaction: `status: compacting` → running, `compact_boundary` → completed, failed `compact_result` → failed; "Not enough messages to compact." = failed.
- [ ] UI: context meter, compaction divider in transcript.
- [ ] Settings: `claude.autoCompactWindow`.

## 13. Subagents + background tasks

- [ ] Subagent traffic by parent tool id → nested `Subagent` events; spawn start/end times (`stamp_event`).
- [ ] `initialize` with `perTaskStopAffordance`; `background_tasks_changed` → `BackgroundTasks`; `stop_task`, `get_task_output`.
- [ ] CLI-started turn (`system:init` with no prompt in flight) → `BackgroundTurn`.
- [ ] Never idle-close a run with live background tasks.
- [ ] UI: nested subagent threads, background tasks panel.

## 14. Titles

- [ ] `run_title`: one turn, no tools/MCP/settings, no initialize. Fallback: first words.
- [ ] Settings: `chat.autoTitle`, `chat.titleModel`.

## 15. Claude provider management

- [ ] Status: version, login state, install location.
- [ ] Sign in / sign out, install / update, latest-release check (npm dist-tag).
- [ ] Plan usage: `GET /api/oauth/usage` with the CLI's token (read, never refresh). ⚠ User-Agent must be `claude-code/<installed version>` or 429.
- [ ] UI: Providers settings page, usage meter.

## 16. Advanced Claude settings

- [ ] Launch args (shell-split), extra env, config dir (`CLAUDE_CONFIG_DIR`) — applied to every spawn.
- [ ] Settings: `claude.launchArgs`, `claude.env`, `claude.configDir`.

## 17. Outcode MCP server

- [ ] Loopback TCP host + token file; bridge = app exe as `outcode mcp` (stdio), tagged with `OUTCODE_CHAT_ID`.
- [ ] Inject via `--mcp-config`; tool timeout ~65 min.
- [ ] Tools one at a time: whoami, show_image, show_svg, preview_html, render_html, request_secret.

## 18. Git

- [ ] Turn snapshots (git tree per prompted turn) → `turn_diff`, `revert_turn`.
- [ ] Worktrees per chat (branch names via `run_title`).
- [ ] UI: diff panel, revert turn.

---

## Later

- **Codex** — `codex app-server` JSON-RPC lines (no `jsonrpc` field). ⚠ Serialize + retry server startups: servers starting together race on `$CODEX_HOME`'s SQLite and one dies.
- **OpenCode 2.x** — `opencode serve`. ⚠ The bun shim starts the real server → kill the whole tree, never `kill_on_drop`. ⚠ MCP config needs `codemode: false` or tools hide.
- **Pi** — `pi --mode rpc`. ⚠ Windows shim is cmd → node → node: stop with `kill_tree`.
- **Remote hosts** — host daemon (engine + store + harnesses) over WebSocket/SSH; client connects to N hosts.

Before adding a harness, extract a `Harness` trait from the Claude code and add a mock harness for engine tests.

## Test checklist per harness

- [ ] Plain prompt → text + Done
- [ ] Tool call → normalized ToolCall + result
- [ ] Approval asked in supervised, skipped in full access
- [ ] Question answered
- [ ] Interrupt mid-turn
- [ ] Follow-up while busy
- [ ] Resume a previous session
- [ ] Compaction
- [ ] Subagent events nest correctly
- [ ] Background task survives turn end, can be stopped
- [ ] Outcode MCP tool call (and a long wait > CLI's default timeout)
- [ ] Attachments (file + image)
- [ ] Title run
