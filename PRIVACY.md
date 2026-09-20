# Privacy Policy — Lumen (ChatGPT Speed Booster)

_Last updated: 2026-09-20_

## Summary

Lumen has no account, no login and no remote server. It never transmits your
data anywhere except back to ChatGPT itself, as described below.

## Data handling

| Item | Detail |
| --- | --- |
| Settings | Stored via `chrome.storage.sync`, so Chrome may synchronize them across the browsers you are signed into. Lumen never sees where they go. |
| Conversation content | Processed locally in your browser to reduce rendering cost (payload trimming, windowed rendering). Lumen does not store conversation content and does not send it to Lumen-owned or third-party servers. |
| Library module | Chat titles and folder/pin assignments you create are stored locally via `chrome.storage.local`. They never leave your browser. |
| Older-message loading | When you scroll up, Lumen makes a same-origin request to ChatGPT (with your existing ChatGPT session) to fetch the already-loaded conversation. This is a request to ChatGPT, not to Lumen. |
| Session access token | The archive loader reads your ChatGPT web session token from ChatGPT's own session endpoint and holds it in memory only, to authenticate those same-origin requests. It is never persisted and never sent anywhere except back to ChatGPT. It is dropped and re-fetched if authentication fails. |
| Network requests | Lumen has no backend and makes no requests to Lumen-owned or third-party servers. Requests to ChatGPT's telemetry/analytics/experimentation endpoints are blocked locally via declarative network rules (ChatGPT-tab scope only — other websites are unaffected). |
| Permissions | `storage` (settings + library), `tabs` (finding open ChatGPT tabs to update them), `scripting` (injecting Lumen into already-open ChatGPT tabs on install/update), `declarativeNetRequest` (local telemetry blocklist) |

## Changes

Any change to this policy will be reflected in a new version of the extension
with an updated date above.
