# hive

Repo: https://github.com/ChillWoW/hive (private) — licensed under GPL-3.0.

Desktop app "Hive": Tauri 2 shell (Rust, `src-tauri/`) around a React 19 + Vite + Tailwind v4 frontend (`src/`). Package manager is bun.

## Commands

- `bun run dev` — frontend only, Vite on http://localhost:1421
- `bun run dev:local` — Tauri dev with the dev config (`Hive Dev`, blue icon)
- `bun run dev:prod` — Tauri dev with the prod config
- `bun run build` — `tsc -b && vite build` into `build/`
- `bun run lint` — oxlint
- `bun run icons` — regenerates `src-tauri/icons/{prod,dev}` and `public/favicon.svg` from `src-tauri/icons/icon.svg` / `icon.dev.svg`. Use this, not `tauri icon` directly (it pads the macOS `.icns`).

## Layout

- `src/main.tsx` — entry; no root `App` component or router yet.
- `src/ui/` — Base UI–based primitives (Button, Menu, Modal, Select, …), exported from `ui/index.ts`.
- `src/lib/cn.ts` — `cn()` (clsx + tailwind-merge) and `mergeClassName()`.
- `src/index.css` — Tailwind theme: `dark-*` / `primary-*` scales and `danger`/`success`/`warning`/`info` tokens.
- `src-tauri/` — plugins: window-state, log (debug only). No custom commands. The main window is frameless (`decorations: false`; macOS overrides in `tauri.macos.conf.json`), so the frontend has to provide its own title bar.
- State: zustand + immer are installed.
- Path alias `@/` → `src/`.

## Conventions

- Commit messages follow Conventional Commits (`feat:`, `chore:`, `fix:`, …) with short subjects. Keep messages brief — a short subject line, body only when truly needed.
- Never add a `Co-Authored-By` trailer (or any other attribution footer) to commit messages.
- Never commit unless the user explicitly asks for it.
