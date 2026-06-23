# Roundtable — Personal Notes (carry this with you)

_Last updated 2026-06-07. Personal context file — gitignored, NOT part of the repo. Paste relevant bits into Cowork on the new PC so we stay on the same page._

## What it is
Electron + React (Vite) + JavaScript desktop chat app. App name "roundtable", appId `com.roundtable.app`, version 0.1.0. Repo: https://github.com/GhostPrime/Roundtable (branch `main`).

Lets multiple AI agents chat as a group ("Roundtable" — auto back-and-forth with a rounds count + Stop button) or 1-on-1.

## Setup on a new machine
```
git clone https://github.com/GhostPrime/Roundtable.git
cd Roundtable
npm install
npm run dev    # uses a --dev flag, since env vars don't survive && on Windows
```
Build installer: `npm run dist` (electron-builder, date-stamped buildVersion, must run on Windows).

## Adding an AI (the AgentForm modal)
Fields: name, provider, endpoint URL, model, optional API key, optional persona.
Providers: `ollama` | `openai` | `anthropic` | `cli`.

- **cli** drives an already-terminal-authed CLI (claude, qwen) by spawning it with `-p` print mode and piping the transcript on stdin — no API key in the app; auth lives in the CLI login. claude also gets `--output-format text`. This is how I use Claude (Claude Pro, no Anthropic API key — Pro can't be called via API).
- Common mistakes: typo `clouid`; picking `cli` provider for a *model name* (then it tries to run the model name as a shell command → "filename syntax is incorrect").

## Local model
`qwen3-coder:30b-a3b-q4_K_M` via Ollama at http://localhost:11434 (Ollama runs as a background service — `ollama serve` errors "address in use" because it's already up).
Ollama **cloud** models: `ollama signin`, then add as the ollama provider with a `:cloud` model suffix (e.g. `kimi-k2.6:cloud`) — still hits localhost:11434, no key needed.

**Weak-PC note for the trip:** the 30b local model needs real hardware. On the underpowered PC, either drop to a small Qwen (1.5B/3B) or lean on cloud agents (Claude CLI / OpenAI / Ollama cloud) which run on their servers, not your machine.

## Architecture
- Model calls happen in the Electron **main process** (`electron/providers.js`), exposed to renderer via preload bridge `window.api`.
- Orchestration: `src/orchestrator.js`. Add/edit modal: `src/AgentForm.jsx`. Project modal: `src/ProjectForm.jsx`.
- Config persists to `agents.json` and `projects.json` in Electron **userData** (`%APPDATA%\roundtable\`). These do NOT live in the repo and do NOT sync via git — copy them by hand if you want your agents/projects on the new PC.
- Main-process files (checks.js / main.js / preload.js / providers.js / store.js) require a **full restart**, not just a refresh.

## Orchestration design (the heart of it)
- **Generative bias** (`BASE_CONSTRAINT`, softened from a hard gate 2026-06-01): speak when you add something (decision, proposal, checkable claim, real critique); prefer substance over agreement; one new idea per turn; no PASS token. The old strict PASS veto muzzled cautious models, so it was dropped.
- **Strict 1:1 speaker discipline**: if a message opens by addressing a seat (`@Name`, `Name:`, `Name,`), ONLY that seat replies (`addressedAgent()`).
- **Discuss / Build mode** (header toggle, defaults to Discuss): `DISCUSS_MODE` / `BUILD_MODE` in orchestrator.js via `withRolePrompt(agent, mode)`. Discuss forbids code/filenames/implementations and pushes understanding-first.
- **Project file access (read + write)**: seats end a turn with a `CHECK:` line — `read_file` / `list_dir` / `exists` / `write_file <path>` (write puts full file content in a fenced block right after). App runs it, appends a real `Tool` result, re-invokes the seat once. Path-locked to the active project folder (`electron/checks.js` `safeResolve` rejects `../` escapes). `write_file` is gated by per-agent `canWrite`. Max 3 checks/turn, one follow-up. This replaced the old "no-hands" muzzle — seats now have real hands but stay path-locked.
- **Backstops kept** (defense-in-depth, not the thesis): subtractor role directive (`SUBTRACTOR_DIRECTIVE`, runs last via `orderSeats`), heuristic round terminator (`roundMadeProgress`), and auto-mute after 2 consecutive failures (`failures` Map + `muted` Set). These exist because local Qwen may not self-gate reliably.

## Shelved / known gaps
- **Thinking panel — SHELVED 2026-06-02.** Was built but removed; never reliably showed reasoning across models (Claude CLI exposes none; Qwen/DeepSeek field-shape uncertain). `splitThinking` is KEPT (still strips inline `<think>` tags from displayed answers). Hooks left in case it's un-shelved.
- Floated, not built: app icon from PNG, persona presets, max-length setting, per-message reasoning.

## Machine gotchas
- Network here blocked Electron's binary auto-download — had to manually grab the electron win32-x64 zip, extract into `node_modules/electron/dist`, and write `node_modules/electron/path.txt` containing exactly `electron.exe` (no trailing newline). May recur on the new PC if its network is similar.
- **Git through Cowork's sandbox leaves a stuck `.git/index.lock`** — run git in the native Windows terminal instead. Daily flow: `git pull` when you start, `git add -A && git commit -m "…" && git push` when you finish.
