# Lumen

ChatGPT gets slow when a chat gets long. Pages take forever to load, scrolling stutters, and your browser keeps rendering hundreds of messages you never look at.

Lumen fixes that. It keeps only the last few messages active, so every chat feels short and fast no matter how big it is.

![Lumen demo](assets/lumen-demo-v2.gif)

## What you get

- Long chats open with a **small, fixed rendering window** instead of the full history
- Old messages are not lost: **scroll up and they load on demand**
- Conversation payloads are trimmed locally, so your browser parses up to **~95-99% less conversation JSON** in synthetic benchmarks
- Fewer turns participating in layout and paint, so long chats **reduce active rendering work**
- ChatGPT's telemetry and analytics endpoints are **blocked** (ChatGPT-only scope, other sites untouched)
- Four independent toggles: instant programmatic scrolling, sidebar optimization, animation trimming, telemetry blocking
- Performance profiles: **Auto** (small chats stay fully native), Fast, Balanced, Extreme, Native, or a custom message limit
- **Lumen Library**: folders, pins and search for your chats, stored locally
- One click pause: Lumen fully steps back and the page reloads pristine

The numbers were measured on realistic synthetic conversation data, see [BENCHMARKS.md](BENCHMARKS.md).

## Install

1. Open `chrome://extensions`
2. Turn on Developer mode (top right)
3. Click Load unpacked and pick this folder

Then open ChatGPT and use it like always. **Free, no account needed.**

## Usage

Works out of the box. Scroll up in a chat to load older messages. Click the Lumen icon to switch profiles, toggle individual features, or pause. The Lumen Library button sits in the page's corner; it stores folders, pins and tags in your browser only.

## Privacy

**No account, no external servers, no tracking of your own.** Lumen processes conversation data locally in your browser to reduce rendering cost; conversation content is never sent to Lumen-owned or third-party servers. Settings sync through your Chrome profile. See [PRIVACY.md](PRIVACY.md).

Works on chatgpt.com in Chrome and Chromium-based browsers (Edge, Brave, Opera). Not affiliated with OpenAI.

## How it works

Short version: when a chat loads, Lumen trims the conversation payload locally (off the main thread) before ChatGPT's frontend parses it, so only a recent window of messages participates in rendering. While you keep chatting it keeps the page light, and older messages are fetched from ChatGPT only when you scroll up. ChatGPT's telemetry endpoints are blocked locally via declarative network rules.
