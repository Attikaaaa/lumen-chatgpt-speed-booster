# Lumen — ChatGPT Speed Booster

**Long ChatGPT conversations get painfully slow. Lumen fixes that.**

If you've ever had a chat that takes forever to open, stutters when you
scroll, and makes your fan spin — that's ChatGPT rendering your entire
history and downloading megabytes of old messages you don't even look at.

Lumen changes the rule: **you only ever see the last few messages — and
that's all ChatGPT has to handle.** Everything else is archived and loads
instantly when you actually scroll up to it.

No setup. No account. No visible UI. It just makes ChatGPT fast.

---

## Why you'll notice the difference

| | Without Lumen | With Lumen |
| --- | --- | --- |
| Opening a long chat | Downloads and renders **every** message | **~75× less data**, only recent messages render |
| Scrolling | Stutters — the browser maintains your whole history | **~62× smaller page** — always smooth |
| While a reply streams in | UI work competes with the stream | Near-zero added work — output stays instant |
| Background traffic | ChatGPT's telemetry runs constantly | Blocked — less noise, more privacy |

Measured on real conversations-shaped data (full methodology and raw
numbers in [BENCHMARKS.md](BENCHMARKS.md)):

- **94–99 % less data** downloaded per conversation
- **~98 % fewer DOM elements** the browser has to maintain
- **95–99 % less main-thread work** — the thing that causes lag

## How it works — in human terms

1. **You open a chat** → Lumen trims it server-side-style before ChatGPT
   processes it: only the most recent messages arrive. Big chats open
   instantly.
2. **You keep chatting** → Lumen keeps the page light automatically, so
   the conversation never grows heavy enough to lag.
3. **You scroll up** → older messages appear when you ask for them.
   Nothing older is ever loaded until you do.
4. **A reply streams in** → Lumen doesn't touch the stream. Text appears
   exactly as fast as the server sends it.

## What it does NOT do

- No sign-in, no account, no tracking — it performs **zero requests of
  its own** and never sends your data anywhere.
- No visible interface inside ChatGPT. The only place you'll see Lumen
  is its small popup.
- It does not read or store your conversations. Everything happens in
  your browser, in memory.

## Install (30 seconds)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

That's it. Open ChatGPT and keep using it normally.

## Tuning (optional)

Click the Lumen icon: pick how many recent messages stay in view
(default 10, range 2–200) or pause the booster. One switch, nothing else.

**Loading older messages:** just scroll up in any chat.

## Privacy

Read the short version: [PRIVACY.md](PRIVACY.md). TL;DR — no collection,
no analytics, no external communication. Ever.

---

*Works with chatgpt.com in Chrome and Chromium-based browsers
(Edge, Brave, Opera…). Lumen is an independent tool and is not
affiliated with OpenAI.*
