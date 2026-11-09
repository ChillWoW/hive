# hive

Repo: https://github.com/ChillWoW/hive (private) — licensed under GPL-3.0.

## What it is

A desktop UI for driving coding-agent CLIs (Claude Code, Codex, OpenCode, …) from one place.

- No provider APIs: Hive spawns the CLIs the user already has installed (e.g. `claude` with stream-json input/output, `codex app-server`) and talks to them over stdin/stdout.
- Each CLI's output is normalized into one common event stream: text, reasoning, tool calls/results, questions, done.
- The UI renders that stream as a live transcript.

## Conventions

- Commit messages follow Conventional Commits (`feat:`, `chore:`, `fix:`, …) with short subjects. Keep messages brief — a short subject line, body only when truly needed.
- Never add a `Co-Authored-By` trailer (or any other attribution footer) to commit messages.
- Never commit unless the user explicitly asks for it.
