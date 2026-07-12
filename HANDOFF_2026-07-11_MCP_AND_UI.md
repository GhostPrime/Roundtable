# Handoff — MCP integrations + WYSIWYG UI pass (2026-07-11)

Written by Claude (Fable) for whoever picks this up next (Opus, Sonnet, or a human).
Two features landed this session: **app integrations via MCP** (GitHub / Google
Drive / Gmail / any MCP server) and a **WYSIWYG UI pass** (seat capability cards,
integrations sidebar section, always-visible status rail, capability empty state).
Everything below is already implemented and on disk; nothing here is a TODO unless
marked as such.

---

## 1. MCP integrations — architecture

Seats can call tools on external services through the existing CHECK text
protocol. No native function-calling; everything rides the same
parse → execute → follow-up-turn loop as `read_file`/`web_search`.

### New seat syntax (taught by the `mcpTools` prompt stage)

```
CHECK: mcp <server-slug>.<tool> {"param": "value"}
```

- Args = ONE JSON object inline, or in a fenced code block on the following
  lines (same convention as write_file content), or absent.
- Counts toward the same 3-checks-per-turn limit. Disabled in DISCUSS mode.
- Server slug = slugified server name (e.g. "Google Drive" → `google-drive`).

### Capability model (mirrors file writes — two gates, both required)

- Tool classification: `annotations.readOnlyHint === true` → **read** (runs
  freely for any seat). Everything else — including tools with NO annotations —
  is a **write** (conservative default).
- Gate 1 (capability, in MAIN): a write-classified tool requires the calling
  agent's **stored** `canWrite === true`, looked up by agentId in main.js —
  a compromised renderer cannot grant it.
- Gate 2 (UX, in renderer): write calls pause for user approval in the
  ActionApproval modal (Approve / Reject / Approve-all-this-chat). Shares
  `pendingWrite` / `writeResolveRef` / `autoApprove` state with WriteApproval,
  so Stop/Esc dismisses it and "approve all" covers both writes and calls.

### Files (backend)

| File | What's in it |
|---|---|
| `electron/mcp.js` | **New.** `McpManager` — connects servers via `@modelcontextprotocol/sdk` (new dependency, in package.json). Transports: stdio (spawns local servers, e.g. `npx …`) and streamable HTTP (remote, e.g. GitHub hosted). `syncServers()` reconciles connections against config (fingerprint-based reconnect). `call()` returns `{ ok, output }` like checks.js — every failure is seat-readable text, never silent. Result text capped at 12 000 chars. Connect timeout 30 s, call timeout 60 s, max 60 tools/server. Auto-prefixes `Bearer ` onto Authorization header values that look like bare tokens (`ghp_…`). |
| `electron/store.js` | Added `loadMcpServers` / `saveMcpServers` / `getMcpServersDecrypted`. Configs persist to `mcp.json` in userData. env + header **values** are secrets: encrypted with safeStorage exactly like agent API keys; renderer only ever sees the `__KEY_SET__` sentinel per value (send it back = keep stored value; new string = re-encrypt; empty = drop key). |
| `electron/main.js` | IPC: `mcp:list` (masked configs + live status/tools), `mcp:save` (persist + reconcile), `mcp:call` (enforces Gate 1, logs to roundtable.log as tag `mcp`). Startup: `mcp.syncServers(...)` in background after `app.whenReady`. `before-quit`: `mcp.closeAll()` kills spawned stdio servers. |
| `electron/preload.js` | `window.api.mcpList()`, `mcpSave(servers)`, `mcpCall(server, tool, args, agentId)`. |

### Files (protocol + prompt)

| File | What's in it |
|---|---|
| `src/orchestrator.js` | `CHECK_RE` gained `mcp` op. `MCP_ARG_RE = /^([\w-]+)\.([\w./-]+)\s*(\{.*)?$/s` parses `server.tool {json}`; falls back to a following fenced block for args; malformed targets are pushed with empty server/tool so the failure is VISIBLE to the seat (main returns "no connected MCP server …"). Both check-resolution loops (runRound + runMission breakouts) forward `server/tool/args` fields through `runCheck`. |
| `src/promptText.js` | `mcpToolBlock(catalog)` — builder, not constant (catalog is dynamic). |
| `src/promptStages.js` | New stage `mcpTools`, placed AFTER `webTool`, applies when `extras.mcpTools` non-empty AND mode !== 'discuss'. When absent, assembled prompts are byte-identical to before (regression-tested). |
| `scripts/check-prompt-regression.js` | Extended: legacy reference + matrix cover the mcpTools stage (spec-change note dated 2026-07-11 in the file). 3024/3024 combinations pass. |

### Files (renderer)

| File | What's in it |
|---|---|
| `src/App.jsx` | `adoptMcpInfo()` folds `mcp:list` into state + `mcpRef` ({ prompt block, Map 'slug.tool' → meta }). `buildExtras(instructions)` merges projectInstructions + mcpTools for every prompt-assembly site (runSeatTurn, runRound, runMission, canvas/inspector). `runGatedCheck` handles `op === 'mcp'` (Gate 2 modal, then `api.mcpCall`, records into `mcpCalls` state for the rail). mcpList polled at startup + once at +5 s (slow stdio servers). |
| `src/ActionApproval.jsx` | **New.** Approval modal for write-classified calls: shows seat (colored), `server.tool`, pretty-printed JSON args, destructive/unknown-tool warnings. |
| `src/McpSettings.jsx` | **New.** Settings modal: server list with live status dots + tool counts, full error text under failed rows, enable/disable/edit/remove, presets (GitHub hosted-HTTP, Google Drive npx, Gmail community npx) + Custom. KV editor for env/headers — values render as the KEY_SET sentinel; retype to replace. |

### Presets — auth notes for the user

- **GitHub**: hosted server `https://api.githubcopilot.com/mcp/` (trailing slash
  matters). Needs a classic PAT with `repo` scope in the Authorization header —
  bare token is fine (auto-Bearer). 401 = token; 404 = URL; 403 may mean the
  account/org hasn't enabled the hosted endpoint → fall back to a local stdio
  GitHub server via npx.
- **Google Drive / Gmail**: local stdio via npx; both need a one-time Google
  OAuth setup per their READMEs (BYOK ethos — user's own credentials). Gmail
  preset is a community server; the modal says to review it before trusting it.

---

## 2. WYSIWYG UI pass (renderer only)

Goal per Phil: "no digging, just wysiwyg" — every capability visible at rest.
Seat colors follow the seat everywhere (sidebar pill, chat bubble, rail dots).

- **Seat cards** (`renderAgentRow` in App.jsx): colored name pill (unchanged) +
  new second line `provider · model` + capability icons 👁 read / ✎ write (only
  if canWrite) / 🌐 web / 🔌 (only when ≥1 MCP server connected). Benched cards
  are dashed + dimmed. CSS: `.agent-card`, `.agent-sub`, `.agent-caps`.
- **Integrations sidebar section** (below "+ Add an AI"): one row per server
  with status dot (green/red/gray), tool count, click → settings modal.
  Empty state = dashed "Connect GitHub, Drive, Gmail…" button. The old
  icon-only 🔌 footer button was REMOVED.
- **Status rail** (new `<aside className="rail">` between `</main>` and the
  side panels): always-visible cards Tasks / Changes / Calls / Files / Scripts
  with live counts and last-3 items (each item gets its seat's color dot).
  Clicking a card toggles the existing full panel (TaskBoard / ReviewPanel /
  McpSettings / FileTree / ScriptsPanel — those components are untouched).
  Pending MCP approval shows "awaiting you" badge on Calls. Collapse state in
  `railOpen`, persisted via localStorage key `railOpen` ('0' = collapsed).
  The four old header toggle buttons were REPLACED by one "▸ Hide rail" toggle.
- **Capability empty state** (launchpad, group chat, seats > 0): "This table
  can…" 2×2 grid driven by LIVE state — project (click → project form), write
  seats count, web, integrations tool count (click → settings). CSS `.cap-*`.
- **Calls tracking**: `mcpCalls` state (last 20, newest first, cleared on New
  Chat) — populated in runGatedCheck's mcp branch.

Chat bubbles were NOT changed — they were already fully colored per seat
(`.bubble.colored`, pastel bg + dark text) and Phil wants that kept.

---

## 3. Verification status

Done this session (sandbox couldn't run the real tree — see gotcha below):
- Prompt regression: 3024/3024 byte-identical incl. new stage (logic replicated
  and run in isolation; the repo's `npm test` uses the same code).
- `CHECK: mcp` parser: 7/7 unit cases (inline/fenced/no args, decorated,
  malformed, cap-at-3, write_file untouched).
- store.js secret round-trip (mask → sentinel-keep → replace).
- **Live end-to-end**: McpManager against `@modelcontextprotocol/server-everything`
  (stdio): connect, 13 tools listed with read/write classification, echo call,
  unknown-tool / bad-JSON / unknown-server error paths all seat-readable.
- Vite dev server booted clean on Phil's machine after all edits.

NOT yet verified: a real GitHub/Drive/Gmail connection (Phil was setting up his
PAT when the session ended), and the UI pass has had no visual QA beyond a clean
Vite boot — eyeball the sidebar/rail spacing on a real window.

---

## 4. Gotchas for the next agent

- **Cowork sandbox staleness**: the Linux-VM view of this mounted folder goes
  stale for files modified by Edit/Write (old truncated snapshots; new files
  sync fine; VM→host writes sync fine). Do NOT trust `npm test` / builds run in
  the VM after editing — reconstruct changed files in /tmp from context, or ask
  Phil to run locally. (Also in memory + NOTES conventions.)
- Electron main files (`electron/*.js`) need a full app restart — Vite HMR only
  covers `src/`.
- `main.js` ends with a `// (MCP integrations added 2026-07-11)` marker comment
  — left over from a sync-debug probe; harmless, delete freely.
- Keep the prompt-regression invariant: any new prompt stage must contribute
  NOTHING when its extras key is absent, and `scripts/check-prompt-regression.js`
  must be extended in the same commit (see the dated spec-change comments there).
- The repo's existing conventions (window.confirm ban, memo'd Markdown,
  RECENT_MSGS cap, KEY_SET sentinel) all still apply — see NOTES.md / memory.

## 5. Sensible next steps (not started)

- Retry/reconnect button per server row (currently: Disable → Enable or
  Refresh status re-polls but doesn't force reconnect on an errored server —
  `syncServers` only reconnects on config change; add a `forceReconnect(id)`).
- OAuth-flow presets for Drive/Gmail with guided setup instead of README links.
- Surface per-tool toggles (disable individual write tools per server).
- Rail: unread/changed-since-last-look indicators; drag to reorder cards.
- `npm run dist` smoke test — electron-builder hasn't been run since the SDK
  dependency was added.
