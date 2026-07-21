# Roundtable — Zero-Budget Launch Plan

Written 2026-07-21. Three parts: (1) get it downloadable, (2) get people to it, (3) close the Cowork gap.

---

## Part 0 — The problem right now

`github.com/GhostPrime/Roundtable` is public and the **code is current** — `origin/main` matches local, full README, MCP integrations and live model picker all pushed. What's missing is what turns a code repo into something people download: **no LICENSE on the remote, no releases, no download link, 0 stars.** Nobody can get a runnable build today. That's the whole gap, and it's small.

Everything below is free. No cert purchase, no Apple Developer account, no hosting bill.

---

## Part 1 — Make it downloadable (target: 1 weekend)

### Step 1 — Push the real code (30 min)

```bash
git remote -v                  # confirm origin
git push origin main
```

Before pushing, verify nothing secret ships:

```bash
git log --all --oneline -S "sk-" -S "api_key" -- . | head
grep -rn "sk-ant\|sk-proj\|AIza" src electron scripts --include=*.js --include=*.jsx
```

Also confirm `.gitignore` covers `release/`, `dist/`, `node_modules/`, `*.local.md`. Your `*.local.md` handoff files (`GIT_PANEL_REGRESSION.local.md`, `ROUNDTABLE_NOTES.local.md`) — decide deliberately whether those go public. Keep the `HANDOFF_*.md` ones out of the repo root either way; they read as internal scratch and make the repo look unfinished.

### Step 2 — Fix the repo's first impression (2 hrs, highest ROI on this list)

The repo page *is* the product page for the first 100 users. In order of impact:

1. **A 30–45 second demo GIF at the top of the README.** Three models arguing about the same prompt, in one thread, with the seat rail visible. This single asset converts more than everything else combined. Record with ScreenToGif (free, Windows), keep it under 10 MB, commit to `docs/demo.gif`.
2. **One-sentence tagline** replacing "A place for Ai to chat with you and themselves." Something like: *"Run Claude, GPT, Gemini and local models in one conversation — bring your own keys, nothing leaves your machine."*
3. **Repo About + topics**: `electron`, `llm`, `mcp`, `ollama`, `local-first`, `byok`, `multi-agent`, `ai-chat`. Topics are how GitHub search surfaces you for free.
4. **LICENSE file** — `package.json` says MIT but there's no LICENSE on the remote. Add it; without it people legally can't use the code.
5. Move the release-notes-generator docs out of README into `docs/release-notes.md`. Right now half your README is about a Python side tool, which buries the actual app.
6. Screenshot of the main UI under the GIF.

### Step 3 — Build releases in CI, not on your desktop (2–3 hrs)

Add `.github/workflows/release.yml` alongside your existing `ci.yml`. Triggered on tag push, it should: build on `windows-latest`, run `npm test`, run `npm run dist`, and upload the installer to a GitHub Release.

Why CI instead of your local `npm run dist`: GitHub Actions is free and unlimited for public repos, the build is reproducible, and you can attach **build provenance attestation** (`actions/attest-build-provenance`, free) — which gives security-minded users a real answer to "why should I run this .exe."

GitHub Releases has no bandwidth cap for public repos, so it's your CDN.

**Change your artifact naming first.** `artifactName: "${productName} Setup ${buildVersion}.${ext}"` produces `Roundtable Setup 0.1.0.202606021611.exe` — spaces in a download URL and a date-stamp nobody can parse. Use `Roundtable-Setup-${version}.${ext}` and let git tags carry the version.

### Step 4 — Deal with the SmartScreen problem (decide now)

Your NSIS installer is unsigned. Every Windows user will see **"Windows protected your PC — Unknown publisher"** and most will bail. This is the single biggest conversion killer for indie Electron apps. Options, cheapest first:

| Option | Cost | Reality |
|---|---|---|
| Ship unsigned + document the "More info → Run anyway" click | $0 | Works, but expect to lose 40–70% of non-technical downloaders |
| **Also ship a portable `.zip`** (`win.target: [nsis, zip]`) | $0 | Extracting a zip dodges the installer warning entirely. Do this regardless — it's a two-line config change |
| **SignPath.io OSS tier** | $0 | Free certificate + signing for qualifying open-source projects. Apply early; approval takes time and they want a real project with real activity. This is the actual free path to a signed binary |
| Azure Trusted Signing | ~$10/mo | Cheapest paid route, but requires a legal business entity 3+ years old — likely disqualifying |
| Traditional OV cert | $200–400/yr | Skip |

**Recommendation:** ship `nsis + zip` unsigned now with an honest "Why does Windows warn about this?" section in the README, and apply to SignPath in parallel. Being upfront about it earns trust with the exact audience (developers, self-hosters) you're targeting first.

### Step 5 — Skip Mac binaries for now

Notarization requires a $99/yr Apple Developer account. An un-notarized DMG on modern macOS is genuinely painful (users must run `xattr -d com.apple.quarantine`). Don't ship a broken first impression. Put "macOS: build from source, see BUILD.md — signed builds coming if there's demand" in the README, and let demand justify the $99 later.

### Step 6 — Auto-update (do it before v0.2, not after)

`electron-updater` with the GitHub provider reads your public Releases feed for free — zero infrastructure. Wire it in early, because retrofitting updates onto users already running v0.1 means they never get v0.2.

### Step 7 — Winget (free, ~1 hr, do it after 2–3 stable releases)

Submitting a manifest to `microsoft/winget-pkgs` costs nothing, doesn't require signing, and gets you `winget install Roundtable` plus a permanent free discovery channel. Use `wingetcreate` to generate the manifest.

---

## Part 2 — First marketing moves (all free)

### The positioning, taken straight from that LinkedIn ad

The ad said: *"We're constantly pitting Codex 5.3, Gemini, and Claude against each other to see who actually wins."*

That's your product description written by someone else. They're doing it manually across three tabs. Roundtable is the tool that does it in one thread. Lead with that friction:

> **"Stop tab-hopping between models. Put them at the same table."**
> Roundtable runs Claude, GPT, Gemini and local Ollama models in a single conversation — they see each other's answers, build on them, and disagree in front of you. Bring your own keys. Nothing routes through a server.

Secondary hooks, pick per-audience:
- **For the model-comparison crowd:** one prompt, N models, side by side, in context.
- **For local-first / privacy people:** runs fully offline against Ollama. No account, no telemetry, no hosted relay.
- **For the agentic crowd:** MCP support, file/folder scoping, write approval, git panel, loop mode with human sign-off.

### Move 1 — Reply to that ad today (5 min, costs nothing)

Don't pitch. Answer the question they asked, then mention the tool as an aside. Something like:

> Leaning on different ones for different jobs, which is exactly the annoying part — the comparison happens across three tabs and I lose the thread. I got tired of it and built a desktop app that runs them in one conversation so they can actually see each other's answers. Open source, BYOK: [link]

Comment-marketing on a relevant ad is the highest-intent free traffic you will find. The advertiser's own audience is self-selected for your exact problem.

### Move 2 — Landing page on GitHub Pages (2 hrs, free)

You already have `plaintext-pro.html` in the repo, so you have the chops. One page: hero GIF, three bullets, download button, "how it works" screenshot, GitHub link. Host at `ghostprime.github.io/Roundtable`. A `.com` domain is ~$10 if you want one later — not needed to launch.

### Move 3 — Launch sequence (order matters)

Do **not** fire everything at once. Sequence it so each channel's feedback improves the next post.

1. **r/LocalLLaMA** — best-fit audience on the internet for a BYOK + Ollama multi-model desktop app. Post as a builder sharing a tool, not as marketing. Lead with the local/Ollama angle, not the "compare paid APIs" angle; that sub is allergic to SaaS pitches. Expect brutal but useful feedback.
2. **r/selfhosted** and **r/ChatGPTCoding** — a week later, adjusted for what LocalLLaMA told you.
3. **Show HN** — "Show HN: Roundtable – run Claude, GPT and local models in one conversation." Tuesday–Thursday, ~9am ET. One shot; make sure the demo GIF and a working download exist first. HN will scrutinize the security model — your Electron sandboxing, SSRF hop validation and folder-scoped write approval are genuine talking points, so write a comment explaining the threat model preemptively.
4. **Product Hunt** — free to launch. Lower technical audience, but good for backlinks and SEO.
5. **LinkedIn + X** — your own posts, reusing the GIF. On LinkedIn the "I built the thing that ad was describing" framing is strong.

### Move 4 — Directory listings (free backlinks, 2 hrs total)

PRs to `awesome-*` lists cost nothing and compound:
- The official MCP client list at modelcontextprotocol.io — you're an MCP *client*, and that list is short. High-value, low-competition.
- `awesome-electron`, `awesome-local-llm`, `awesome-mcp-clients`, `awesome-ai-tools`.
- alternativeto.net entry, positioned against ChatGPT desktop / LM Studio / Claude Desktop.

### Move 5 — Build in public (ongoing, ~20 min/day)

You already write detailed handoff docs. Turn one per week into a short post: "how I got 288 prompt-assembly combinations under a byte-identical regression test," "why my agents needed a generative gate to stop talking over each other." Technical build-in-public posts are how solo devs get their first thousand users without a budget. Your orchestration work (speaker discipline, auto-mute, subtractor/terminator) is genuinely novel — that's the content.

### What to measure

GitHub stars are vanity; track **release download counts** (free via the GitHub API) and **issues opened**. Ten people filing bugs beats a thousand stars.

---

## Part 3 — What Roundtable needs to feel like Cowork

Roundtable already has a lot of the substrate: MCP client, memory panel, file tree + folder scoping, write approval, git panel, scripts panel, web panel, task board, loop mode, review panel, multi-provider + CLI agents. The gap isn't capability, it's **packaging for people who don't think like developers.**

### Tier 1 — The real differentiators (build these)

1. **Skills** — a folder-based skill format (`SKILL.md` + supporting scripts) the app discovers and injects only when relevant. This is the single biggest Cowork feature you're missing, and it's mostly prompt plumbing on top of machinery you already have. It also gives you an ecosystem story: users share skills, skills pull in users.

2. **Document output (docx / xlsx / pptx / pdf)** — Cowork's "make me a deck / report / spreadsheet" is what makes non-developers care. Today Roundtable can only write text and code. Bundling `python-docx`/`openpyxl`/`python-pptx` equivalents (or the JS ones: `docx`, `exceljs`, `pptxgenjs` — no Python dependency, better for an Electron app) is a contained, high-visibility win.

3. **Scheduled tasks** — "run this every morning at 6." A cron table + a headless run path into your existing orchestrator. Turns a chat app into something that works while you sleep, and it's a strong retention mechanic.

4. **A real sandbox for code execution** — Cowork runs code in an isolated Linux VM. You have a scripts panel; the missing piece is isolation. Given Electron, the honest options are WSL2 on Windows, a bundled Docker path, or a WASM runtime for Python. This is your hardest item — scope it carefully or defer it.

### Tier 2 — Onboarding and polish (this is what actually converts downloads into users)

5. **First-run wizard.** Right now a new user opens the app and faces a blank table. Cowork's advantage is that it asks you three questions and then works. Ship a wizard: detect Ollama → offer a one-click local seat → or paste one API key → then load a preset table ("Debate", "Code review", "Research") so the first message produces something impressive within 60 seconds.

6. **Preset agent templates.** Nobody wants to configure five agents from scratch. Ship 4–6 curated tables.

7. **Clarifying questions before work starts.** Cowork asks multiple-choice questions before long tasks. Cheap to implement in your prompt stages, big perceived-intelligence gain.

8. **Artifacts / live views** — persisted HTML views the user reopens later. You already have `PreviewPanel` and `PromptFlowCanvas`; the missing part is persistence plus a data-refresh hook.

9. **File presentation cards** — when an agent writes a file, show a clickable card, not a path in a code block. Small change, disproportionate polish.

10. **Finish the sidebar TODO list.** Every item in your `TODO.md` (collapsible sections, hover row-actions, SVG icons instead of emoji, drag-to-reorder) is a "this looks like a real product" item. Emoji icons rendering inconsistently on Windows is exactly the kind of thing HN comments on.

### Tier 3 — Ecosystem (later)

11. **Connector catalog with OAuth** — Cowork's Slack/Gmail/Drive connectors. You have raw MCP support, which is more powerful but requires JSON editing. A browsable catalog with guided setup is the productization. Your `mcp-yahoo-mail.js` is the proof of concept; generalize the pattern.
12. **Plugin/marketplace format** — bundles of skills + MCP servers, installable in one click.
13. **Subagents** — spawn an isolated agent for a subtask and return only the result. Your bench/seat model is already close to this conceptually.
14. **Computer use / browser control.**

### What Roundtable has that Cowork doesn't — lead with this

Don't position as "Cowork but free." Position on the axis where you actually win:

- **Multi-model in one conversation.** Cowork is one model. This is the whole pitch and it's the thing the LinkedIn ad was begging for.
- **Fully local capable.** Ollama seats mean it runs with no account, no subscription, no data leaving the box.
- **Provider-neutral BYOK.** No vendor lock-in.
- **Visible orchestration.** Your speaker discipline, generative gate and prompt-flow canvas make the machinery inspectable. Nobody else shows this.
- **Open source, MIT.**

---

## Sequenced first 30 days

| When | What |
|---|---|
| Day 1 | Push `main`. Add LICENSE. Fix About + topics. Secret-scan first. |
| Day 1 | Reply to the LinkedIn ad. |
| Day 2–3 | Record demo GIF. Rewrite README around it. Move release-notes docs out. |
| Day 4–5 | `release.yml` workflow, `nsis + zip` targets, fix artifact naming, cut **v0.1.0** with real release notes. |
| Day 6–7 | GitHub Pages landing page. Apply to SignPath OSS. |
| Week 2 | First-run wizard + preset tables. This gates every launch post — don't post before it exists. |
| Week 2 | Wire `electron-updater`. |
| Week 3 | Post to r/LocalLLaMA. Fix whatever they tear apart. |
| Week 3–4 | Skills system v1. Directory-listing PRs. |
| Week 4 | Show HN, with a pre-written comment on the security model. |

**The one thing that gates everything:** a working download plus a 45-second demo GIF. Until both exist, every marketing move wastes its traffic.
