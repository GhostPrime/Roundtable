# Roundtable

![CI](https://github.com/GhostPrime/Roundtable/actions/workflows/ci.yml/badge.svg)
![Downloads](https://img.shields.io/github/downloads/GhostPrime/Roundtable/total?label=downloads&color=4f8cff)
[![Buy Me a Coffee](https://img.shields.io/badge/support-buy%20me%20a%20coffee-ffdd00)](https://buymeacoffee.com/ghostprimer)

**[⬇ Download for Windows](https://ghostprime.github.io/Roundtable/)**

A bring-your-own-key (BYOK) multi-AI chat application where models from
different providers can converse in the same conversation. Built with
Electron, React, and Vite.

## Features

- **Multi-agent conversations** — run several AI models side by side and have
  them respond in the same thread.
- **Bring-your-own-key** — API keys are supplied by the user and used locally;
  the app does not route them through a hosted server.
- **Projects with folder-scoped file access** — scope an agent's file access to
  a specific project folder.
- **Abortable agent calls** — cancel in-flight requests mid-response.
- **Agent duplication** — clone an existing agent from the sidebar.
- **Provider fallbacks** — graceful handling when a provider can't process a
  given input (e.g. image inputs on DeepSeek).

## Getting started

```bash
npm install
npm run dev      # runs Vite + Electron together (development)
```

Other scripts:

```bash
npm start        # production build, then launch
npm run dist     # build a distributable Windows package
npm test         # run the prompt-assembly regression check
```

You'll need API keys for the providers you want to use; add them through the
app's settings. Keys are stored and used locally.

## Automated testing & CI

Prompt construction is the highest-stakes logic in the app — it decides what
every model is actually told — so it's guarded by an exhaustive regression
check rather than manual review.

[`scripts/check-prompt-regression.js`](scripts/check-prompt-regression.js)
verifies that the stage-based prompt builder produces output **byte-identical**
to an independently-stated reference assembly across **all 288 combinations** of
mode × role × write-permission × provider × system-prompt. If a refactor
silently changes a single character of any prompt, the check fails and prints
the exact divergence point.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs that check on every
push and pull request to `main`. It has zero third-party dependencies, so CI is
fast and deterministic — the badge above reflects the latest run. Run it
locally any time with `npm test`.

---

# Release Notes Automation

`release_notes_gen.py` is a small command-line tool that replaces a manual
changelog process. Given two Git refs, it pulls the commits between them from
the GitHub API and uses an LLM (Claude) to produce categorized release notes
**plus a risk-review section** flagging changes a release manager should verify
before sign-off.

It's a BYOK tool: credentials are read from environment variables and are never
stored or sent anywhere except the GitHub and Anthropic APIs.

## Requirements

- Python 3.9+
- `pip install requests`
- A GitHub token (`GITHUB_TOKEN`) — optional for public repos, required for
  private repos and to avoid the unauthenticated rate limit
- An Anthropic API key (`ANTHROPIC_API_KEY`)

## Setup

```bash
pip install requests
export GITHUB_TOKEN="your_github_token"          # PowerShell: $env:GITHUB_TOKEN="..."
export ANTHROPIC_API_KEY="your_anthropic_key"    # PowerShell: $env:ANTHROPIC_API_KEY="..."
```

The model is set near the top of the script (`claude-sonnet-4-6` by default);
change it to any model your API key can access.

## Usage

```bash
# Preview the commits without calling the LLM (spends no API credit)
python release_notes_gen.py --repo owner/name --from v1.0.0 --to HEAD --dry-run

# Generate notes and write them to a file
python release_notes_gen.py --repo owner/name --from v1.0.0 --to HEAD -o NOTES.md
```

| Flag | Description |
|------|-------------|
| `--repo` | GitHub repository as `owner/name` |
| `--from` | Base ref (tag, branch, or commit SHA) |
| `--to` | Head ref (default: `HEAD`) |
| `-o`, `--output` | Write notes to a file instead of stdout |
| `--dry-run` | Fetch and print commits only; skip the LLM call |

## Example output

Generated from this repository:

```markdown
## Features
- Multi-AI chat application - Initial implementation of the Roundtable multi-AI chat app. (4792a36)
- Projects with folder-scoped file access - File access restricted to a specific folder. (daf641f)
- Abortable agent calls - Agent requests can be cancelled mid-flight. (daf641f)
- Agent duplication - Agents can be duplicated from the sidebar. (30c8025)

## Fixes
- Folder-access hardening - Strengthened enforcement of folder-scoped file access. (30c8025)

## Risk Review
| Change | Reason to verify |
|---|---|
| Folder-scoped file access | Access-control logic - verify no path-traversal or escape vectors. |
| Abortable agent calls | Cancellation in async flow can leave resources inconsistent; verify cleanup. |
| DeepSeek image fallback | Fallback alters data sent to an external provider; verify no unintended leakage. |
```

## Notes

- Keys are read from the environment, never hardcoded. Don't commit them.
- The GitHub *compare* API counts commits after the base ref, so the base
  commit itself is the starting line rather than part of the range.

## License

MIT
