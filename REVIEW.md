# Roundtable — Code & UI Review (2026-07-01)

Full-codebase review: renderer (App.jsx, orchestrator.js, forms, ScriptsPanel), Electron main
(main.js, providers.js, checks.js, store.js, preload.js), index.html/CSP.
Items marked ✅ were fixed the same day as this review.

## Bugs / correctness

1. ✅ **Anthropic `max_tokens: 1024`** (providers.js) — too low for a coder seat; long answers
   silently truncated. Now honors per-agent `maxTokens`, defaults to 4096.
2. ✅ **Symlink escape in the file jail** (checks.js `safeResolve`) — `path.resolve` is lexical
   and doesn't follow symlinks, so a symlink inside the project pointing outside escaped the
   root. Now realpaths the nearest existing ancestor and re-checks containment.
3. **CLI timeout fixed at 120s** while HTTP gets 300s — real coding turns from claude/qwen can
   exceed 120s. Make both configurable (per-agent or a shared setting).
4. ✅ **index.html title** was still "Electron Chat" — now "Roundtable".
5. **`stdin.write` in `callCli` can throw EPIPE** if the child dies instantly — add a
   `child.stdin.on('error')` handler or try/catch.

## Still-open security item

6. **baseUrl warning for keyed agents** (last item from SECURITY_FIXES.md) — AgentForm doesn't
   warn when an API key will be sent to a custom or non-HTTPS endpoint. Small AgentForm add:
   warn when `needsKey` and baseUrl ≠ the provider default (or isn't https).

## Architecture / cost

7. **Full transcript re-sent every turn, every seat, every round** — token cost grows
   quadratically; base64 images ride along each time. Add a context window (last N entries +
   running summary).
8. **Duplicated check-resolution loop** — `runSeatTurn` in App.jsx reimplements orchestrator's
   `resolveChecks`. Extract one shared function.
9. **No streaming** — UI shows "…thinking" for minutes. Ollama/OpenAI/Anthropic all support
   streaming; single biggest feel-improvement available.

## Cowork-like behavior

10. ✅ **Shared task board** — seats emit `TASK: add|done` lines (parsed like CHECK, taught by
    the new TASK_BOARD prompt stage, both modes), shown in a ☑ Tasks panel with user
    add/toggle/remove. Per-chat; regression spec updated (288/288).
11. ✅ **Live per-seat status** — pending bubble now shows "X is thinking… · Round 2/3",
    "X is reading path…", "X is reading the results…" with a pulsing dot in seat color.
12. ✅ **Write approval with diff preview** — `write_file` now pauses for a diff modal
    (Approve / Reject / Approve-all-this-chat; dep-free LCS diff in src/diffLines.js).
    Rejection returns a failed check so the seat adjusts. Auto-approve indicator in header;
    Stop/New Chat auto-reject a pending approval.
13. **File cards in the transcript** — writes render as clickable cards (open/reveal/diff)
    instead of raw Tool text. ScriptsPanel already has the pieces.
14. **Structured questions to the user** — an `ASK:` directive letting a seat pose a
    multiple-choice question rendered as buttons.
15. **Session persistence + history** — transcripts vanish on restart. Save per-project to
    userData; add a "Past chats" list.

## UI backlog

16. ✅ Markdown + syntax-highlighted code in bubbles — dep-free src/Markdown.jsx (React
    elements only, no innerHTML), incl. Copy button on code blocks.
17. Collapsible 💭 reasoning toggle — `splitThinking()` already stores it; UI never shows it.
18. ✅ Multi-line composer textarea (Enter=send, Shift+Enter=newline, auto-grow).
19. Collapsible Tool bubbles (one-line summary, expand on click).
20. 🔇 indicator on auto-muted seats — mute state exists but is never surfaced in the sidebar.
21. @mention autocomplete in composer — `addressedAgent()` supports it, but undiscoverable.

## Suggested order

Quick fixes (1, 2, 4 ✅) → fast UX wins (16, 18, 11 ✅) → Cowork core (10 + 12 ✅) →
next up: 17 (reasoning toggle), 19 (collapsible Tool bubbles), 20 (🔇), 21 (@mention),
then bigger lifts: 9 (streaming), 15 (session persistence), 7 (context window).
