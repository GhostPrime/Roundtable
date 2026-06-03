# Building Roundtable

Roundtable is an Electron app. You can build a standalone installer for
**Windows** (`.exe`) and **macOS** (`.dmg`). Each OS must be built on that OS —
you can't build the Mac version on Windows, or vice versa (Apple's toolchain
only runs on macOS).

---

## Prerequisites (any platform)

- [Node.js](https://nodejs.org) 18 or newer
- The project folder, **without** `node_modules` (it's platform-specific —
  reinstall fresh on each machine)

From the project folder, first install dependencies:

```
npm install
```

---

## Windows installer (.exe)

On a **Windows** machine:

```
npm run dist
```

When it finishes, the installer is in the `release/` folder:

```
release/Roundtable Setup 0.1.0.<timestamp>.exe
```

Share that file. Running it installs Roundtable with a Start-menu entry.

> First launch shows a SmartScreen warning ("Windows protected your PC")
> because the app isn't code-signed. Click **More info → Run anyway**.

---

## macOS installer (.dmg)

On a **Mac**:

```
npm install
npm run dist:mac
```

The installer lands in `release/`:

```
release/Roundtable-0.1.0.dmg
```

Open it and drag **Roundtable** into Applications.

> The app isn't signed/notarized, so Gatekeeper blocks the first launch
> ("unidentified developer"). Bypass it with **right-click the app → Open**, or
> System Settings → Privacy & Security → **Open Anyway**. Proper signing needs a
> paid Apple Developer account ($99/yr) — not required to run it.

---

## Important: what each user still needs

The installer ships the **app**, not the AI backends or any API keys. API keys
are stored locally per machine and are **never** included in the build. Each
person who installs Roundtable configures their own seats:

- **Ollama (local models)** — install [Ollama](https://ollama.com), then
  `ollama pull <model>` for each model they want. In the app, use the "Load
  installed models" button to pick one.
- **Claude / Qwen via CLI** — they must be logged into that CLI in their own
  terminal. No API key needed; the app uses their terminal login.
- **OpenAI / DeepSeek / Anthropic (API)** — they paste their **own** API key in
  the Add/Edit AI form. Use **Test connection** to confirm it works.

Use the **⚡ Test connection** button when adding an AI to catch a missing key
or wrong model name before starting a chat.

---

## Other build commands

| Command         | What it does                                            |
|-----------------|---------------------------------------------------------|
| `npm run dev`   | Run the app in development (hot reload)                  |
| `npm run dist`  | Build the Windows installer (.exe)                       |
| `npm run dist:mac` | Build the macOS installer (.dmg) — **macOS only**     |
| `npm run pack`  | Build an unpacked Windows app folder (no installer)      |

Icons live in `build/` (`icon.ico` for Windows, `icon.icns` for macOS).
