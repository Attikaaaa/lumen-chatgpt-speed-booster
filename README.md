# Lumen — ChatGPT Speed Booster

**Lumen** keeps ChatGPT fast and light. Only the most recent messages of a
conversation are rendered — everything older is archived and loads on demand
as you scroll up. No visible UI, no accounts, no tracking.

## Features

- **Instant conversations** — heavy conversation payloads are trimmed to the
  most recent messages before ChatGPT processes them. JSON work runs on a
  dedicated Web Worker, so the page's main thread stays free.
- **Capped DOM** — the number of mounted conversation turns is continuously
  limited while you chat, keeping scrolling smooth in sessions of any length.
- **Progressive history** — scroll up and older messages appear: first turns
  already in the DOM are revealed, then archive chunks are fetched on demand
  and mounted as read-only turns. Nothing that is not needed is ever loaded.
- **Render cost reduction** — off-screen turns skip layout and paint
  (`content-visibility`), frosted-glass blur is removed, programmatic
  scrolling is instant.
- **Network hygiene** — telemetry, A/B flagging and error-reporting traffic
  is blocked via declarative net request rules. Lumen itself performs zero
  external requests.

## Installation (developer mode)

1. Download / clone this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extension root folder
   (the one containing `manifest.json`).

## Project structure

```
├── manifest.json               # MV3 manifest
├── rules.json                  # declarativeNetRequest blocklist
├── icons/                      # toolbar + store icons
├── _locales/                   # en translations
├── bench/                      # reproducible benchmarks (see BENCHMARKS.md)
└── src/
    ├── background/
    │   └── service-worker.js   # settings seed + live broadcast
    ├── content/
    │   ├── main-world.js       # fetch trimming (worker), scroll patches
    │   ├── content.js          # DOM cap, progressive history, messaging
    │   └── content.css         # rendering-cost rules + archive styling
    └── popup/
        ├── popup.html          # popup markup
        ├── popup.css           # popup styles (bundled Inter font)
        └── popup.js            # popup controller
```

## Performance

Measured numbers and methodology: [BENCHMARKS.md](BENCHMARKS.md).

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: no data collection, no external
communication, everything stays on your device.

## License

All rights reserved. © Lumen
