# Roundtable Mobile (Android)

Multi-AI chat for Android, built from the same idea as desktop Roundtable —
but for phones, and with assistant actions: model replies can carry calendar
events, reminders, and email drafts that you apply with one tap.

## What it does

- **Chat** with Anthropic (Claude), any OpenAI-compatible API, or Ollama on
  your LAN. API keys are entered per-AI in the app and stored on-device only.
- **Calendar**: "add dentist appointment Thursday 2pm" → tap **Google
  Calendar** (prefilled) or **Share .ics** (any calendar app).
- **Reminders**: "remind me to call Mom at 5pm" → tap **Set reminder** → a
  local notification fires at that time. No account, works offline.
- **Email**: "draft an email to my landlord about the leaky faucet" → tap
  **Open in mail app** → Gmail (or your default) opens prefilled.

No CLI provider on Android — phones can't run the Claude/Gemini CLIs. Use an
Anthropic API key, or Ollama over Wi-Fi (`http://<pc-ip>:11434`).

## Getting the APK

Push this branch to GitHub. The **Android APK** workflow builds it; download
`roundtable-apk` from the run's Artifacts, copy `app-debug.apk` to your phone,
and install it (enable "install from unknown sources" when prompted).

Or build locally with Android Studio:

```
cd mobile
npm install
npm run android   # builds web app, syncs, opens Android Studio
```

## How actions work

The app appends an instruction block to every request telling the model it
may emit fenced ` ```rtaction ` JSON blocks (event / reminder / email). The
app strips those from the displayed reply and renders them as tappable cards.
Nothing runs without your tap.

## Layout

- `src/providers.js` — API adapters (ported from `electron/providers.js`,
  minus CLI). Capacitor's native HTTP is enabled, so no CORS and cleartext
  LAN Ollama works.
- `src/actions.js` — rtaction parsing, .ics generation, notification
  scheduling, mailto building.
- `src/App.jsx` — chat UI, agent management (localStorage persistence).
- `android/` — generated Capacitor project (committed so CI just runs Gradle).
