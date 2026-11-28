# Outcode

A desktop app for driving coding-agent CLIs from one place.

Outcode doesn't talk to any provider API. It runs the agent CLIs you already have installed and signed in to, and shows what they do as a live transcript, so your existing subscriptions and logins keep working as they are.

## Supported agents

| Agent | CLI |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Antigravity | `agy` |

Install and sign in to at least one of them before starting a chat.

## Features

- **Chats**: several chats in tabs, each with its own agent, model and folder. Chats and their history survive restarts, and you can search inside a chat.
- **Worktrees**: run a chat in its own git worktree so agents don't step on each other or on your checkout.
- **Changes**: see what the last turn changed as a diff, and undo it.
- **Git**: branches, commit history with a graph, and committing from the app.
- **Files**: a file tree, an editor with tabs, and text search across the folder.
- **Terminal**: your shell in terminal tabs.
- **Browser**: web pages in tabs, shared with your agents. They can open, read, click, type and take screenshots through Outcode's MCP server.
- **Yours to shape**: themes (built in, or your own as JSON files), fonts, and rebindable keyboard shortcuts.
- **Updates**: built-in updater with stable and pre-release channels.

## Install

Download the latest build from the [releases page](https://github.com/ChillWoW/outcode/releases).

- **Windows**: run the installer.
- **macOS**: open the `.dmg` (universal: Apple Silicon and Intel). The app isn't notarized, so the first launch has to be allowed in System Settings › Privacy & Security.

Browser tabs are complete on Windows. On macOS, screenshots, back/forward state and app shortcuts pressed inside a page aren't there yet.

## Development

You need [Bun](https://bun.sh), [Rust](https://rustup.rs) and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
bun install
bun run dev:local
```

| Command | What it does |
| --- | --- |
| `bun run dev:local` | Run the app with the dev config ("Outcode Dev", data in `~/.outcode.dev`) |
| `bun run dev:prod` | Run the app with the prod config (data in `~/.outcode`) |
| `bun run dev` | Frontend only, no backend |
| `bun run build` | Typecheck and build the frontend |
| `bun run lint` | Lint with oxlint |
| `cargo test` | Run the Rust tests |

`cargo test -p outcode-proto` regenerates the TypeScript wire types in `src/proto/`; don't edit them by hand.

### Layout

- `src/`: the React frontend (React 19, TypeScript, Vite, Tailwind, Zustand).
- `src-tauri/`: the Tauri shell and its commands.
- `crates/harness`: spawns the agent CLIs and turns their output into one common event stream.
- `crates/engine`: chats and their live runs.
- `crates/store`: SQLite and per-chat event journals.
- `crates/git`, `crates/terminal`, `crates/mcp`, `crates/proto`: git and worktrees, the terminal's pty, the MCP server agents connect to, and the wire types.

## License

[GPL-3.0](LICENSE)
