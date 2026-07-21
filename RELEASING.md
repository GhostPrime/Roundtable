# Releasing Roundtable

## Normal path (CI builds it for you)

```bash
git add -A
git commit -m "your changes"
git push origin main

git tag v0.1.1          # bump the number each release
git push origin v0.1.1
```

The tag push triggers `.github/workflows/release.yml` on a GitHub Windows runner:
it runs the prompt-regression test, builds the NSIS installer + portable zip, and
creates a **draft** GitHub Release with both attached.

1. Watch the **Actions** tab (~5–10 min).
2. Go to **Releases**, check the two files are attached, click **Publish**.

Download links:

```
https://github.com/GhostPrime/Roundtable/releases/latest                          ← use this in README/marketing
https://github.com/GhostPrime/Roundtable/releases/download/vX.Y.Z/Roundtable-Setup-X.Y.Z.exe
```

## Fallback (CI fails — build locally)

Most likely CI failure: the `asarUnpack` list in `electron-builder.yml` (a package
missing from the unpack globs, or a native dep). Fix later; ship now:

```bash
npm run dist
```

Output lands in `release/`. Then:

1. GitHub → Releases → **Draft a new release**.
2. Tag: `vX.Y.Z` (create it from the UI if you didn't push one).
3. Drag `Roundtable-Setup-X.Y.Z.exe` and the `.zip` from `release/` onto the page.
4. Publish.

Same links work either way.

## Pre-release sanity check (2 min)

- Install the exe on a machine (or after renaming the repo folder) and confirm
  the Yahoo Mail MCP connects — proves the app is self-contained.
- Confirm the zip version launches by double-clicking `Roundtable.exe` inside it.

## Version bumps

Update `version` in `package.json` before tagging — the artifact name and the
in-app version both come from it. Tag must match: `v` + package.json version.
