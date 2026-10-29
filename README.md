# Hive

A desktop app for driving coding-agent CLIs (Claude Code, Codex, OpenCode) from one place.

> **Personal project.** Hive is something I build for myself, in my own time. It's shared as is: no support, no roadmap, and things may change or break without notice.

> **Inspired by Zeron.** Much of Hive's design and behaviour is heavily inspired by the Zeron app.

## How it works

Hive doesn't call any provider APIs. It starts the CLIs you already have installed and logged in (`claude`, `codex app-server`, `opencode serve`) and talks to them over stdin/stdout or their local servers. Each CLI's output is normalized into one event stream (text, reasoning, tool calls, questions) and rendered as a live transcript.

## Features

- Chats with Claude Code, Codex and OpenCode, side by side
- Plan mode, access modes (supervised / auto-accept edits / full access) and approval questions
- Queued prompts, steering, interrupts, and background tasks
- File attachments and `@` file mentions
- Git branches and per-chat worktrees
- A file tree, code editor and terminals in the side panels
- Context and plan-usage rings, notifications, and custom keyboard shortcuts

## Requirements

- At least one of the supported CLIs installed and signed in: [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) or [OpenCode](https://opencode.ai) (2.x)
- `git` for branch and worktree features

Windows is the main platform for now. macOS is coming soon.

## Development

Built with [Tauri 2](https://tauri.app) (Rust) and React 19 + Vite + Tailwind v4. Uses [bun](https://bun.sh).

```sh
bun install
bun run dev:local   # the app in dev mode ("Hive Dev")
bun run dev         # frontend only, in the browser at http://localhost:1421
bun run build       # type-check and build the frontend
bun run lint
```

## License

[GPL-3.0](LICENSE)
