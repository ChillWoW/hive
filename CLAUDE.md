# outcode

Repo: https://github.com/ChillWoW/hive (private) — licensed under GPL-3.0.

## What it is

A desktop UI for driving coding-agent CLIs (Claude Code, Codex, OpenCode, …) from one place.

- No provider APIs: Outcode spawns the CLIs the user already has installed (e.g. `claude` with stream-json input/output, `codex app-server`) and talks to them over stdin/stdout.
- Each CLI's output is normalized into one common event stream: text, reasoning, tool calls/results, questions, done.
- The UI renders that stream as a live transcript.

## Status

Branch `rework/app` is a from-scratch rebuild. So far: app shell (top bar, window controls, resizable sidebar), settings, themes, fonts, keybindings, updater, toasts, UI kit. `ROADMAP.md` is the step-by-step plan (Claude Code first, vertical slices); follow it and tick boxes as steps land. `HARNESS_REBUILD.md` has the fuller harness design and ⚠ gotchas.

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
- `src-tauri/src/` — Tauri commands, registered in `lib.rs`: `chat.rs` (engine commands, watchers), `folders.rs`, `git.rs`, `files.rs`, `settings/`, `themes.rs`, `fonts.rs`, `updater.rs`, `http.rs`.
- `crates/proto` — wire types; `cargo test -p outcode-proto` regenerates `src/proto/` (never edit by hand).
- `crates/harness` — spawns agent CLIs, normalizes output to `AgentEvent`s. Live tests: `cargo test -p outcode-harness -- --ignored`.
- `crates/git` — a folder's branches over the user's `git` CLI (list, switch, create, delete).
- `crates/store` — SQLite (`outcode.db`: chats, messages) + per-chat JSONL event journals; `recover()` closes turns a crash left open.
- `crates/engine` — chats and their live runs over the store: one run per chat, resumed by session id, closed when idle; `watch_chats` / `watch_messages` stream a snapshot then changes.

## Conventions

- Settings: `src-tauri/src/settings/schema.rs` is the source of truth, mirrored in `src/features/settings/types.ts` — change both together. Add a setting only once something reads it; keep sections to plain leaves.
- Themes: built-ins in `src/features/theme/themes.ts`; user themes are JSON files in `<data dir>/themes/` (files starting with `_` are skipped).
- Commit messages follow Conventional Commits (`feat:`, `chore:`, `fix:`, …) with short subjects. Keep messages brief — a short subject line, body only when truly needed.
- Never add a `Co-Authored-By` trailer (or any other attribution footer) to commit messages.
- Never commit unless the user explicitly asks for it.
