# Release Notes: GhostPrime/Roundtable
**Range:** 607d487 to HEAD

---

## Features

- Initial implementation of Roundtable, a multi-AI chat application (4792a36)
- Add Projects support with folder-scoped file access, giving agents controlled access to local directories (daf641f)
- Add abortable agent calls, allowing in-flight requests to be cancelled (daf641f)
- Redesign sidebar for improved navigation and layout (30c8025)
- Add agent duplication functionality (30c8025)
- Add DeepSeek image fallback handling (30c8025)

## Fixes

- Harden folder-access controls to reduce unauthorized or unintended file access (30c8025)

---

## Risk Review

- **Folder-scoped file access (daf641f, 30c8025)** - Grants agents read access to local directories; scope boundaries and path-traversal protections should be manually verified before sign-off.
- **Folder-access hardening (30c8025)** - A fix to access controls implies a prior weakness was present; verify the hardening is complete and no edge cases remain.
- **Abortable agent calls (daf641f)** - Cancellation logic in async/streaming contexts can leave resources in inconsistent states; verify cleanup on abort.
- **DeepSeek image fallback (30c8025)** - Fallback logic for a third-party model integration may have implications for content handling or unexpected API behavior; verify fallback conditions and outputs.
