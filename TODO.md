# TODO

## Features

- [x] **Web context preview window** — preview pane for web content pulled into context (pages fetched by seats via web search/fetch), so you can see what the agents are actually reading before/while it's injected. (added 2026-07-17, done 2026-07-18 — `WebPanel.jsx` + 🌐 Web rail card)

## Sidebar UI (from 2026-07-17 review)

- [ ] Drop the redundant `seat-pill` (seat number button + accent border already signal state)
- [ ] Hover-reveal per-card `row-actions` (⛓ ⧉ ✎ ✕)
- [ ] Only show differentiating capability icons (✎ write, 🔌 MCP) — hide always-on 👁 🌐
- [ ] Collapsible sidebar sections (Sessions / Project / Table / Bench / Integrations), persist state
- [ ] Cap session list to ~5 recent + "Show all"
- [ ] Resizable sidebar or bump to ~270px
- [ ] Drag-to-reorder speaking order
- [ ] Move session export buttons (⤓, `{}`) to a per-session kebab or chat header
- [ ] Reconcile "New session" (+) vs "✚ New chat"
- [ ] Replace emoji icons with inline SVG (lucide) for consistent Windows rendering
