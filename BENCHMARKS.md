# Lumen — Benchmark Results

_Measured: 2026-09-20 · Machine: developer's Windows PC · Node v22.19.0 ·
Chrome 153.0.8010.50 (headless) · Extension build: v2.0.0_

## Methodology

Two benchmarks, both running the **actual shipped extension code** — no
re-implementations, no estimates.

1. **Payload benchmark** (Node.js): conversations shaped exactly like
   ChatGPT's `/backend-api/conversation/:id` responses (mapping graph,
   message nodes, markdown/code bodies, ~1.2 KB average text per message)
   are processed by the real `main-world.js` trim pipeline, loaded into a
   sandbox from the shipped file. The worker path mirrors the shipped
   `blob:`-worker flow (parse + trim + stringify off the main thread).
   Timings are medians of 5 runs. Keep value = 10 (extension default).
2. **DOM benchmark** (headless Chrome): 1 500 conversation turns built with
   ChatGPT-like markup (4-level container nesting, paragraphs, lists,
   double code blocks — 23 008 DOM nodes total, ~7 MB of HTML). Measures
   full-tree layout time and style+layout recalc cost without the
   extension, with Lumen's content stylesheet, and with the DOM limiter
   active (last 10 turns).

## Results — network & processing

| Messages | Payload without Lumen | With Lumen | Saved | Main-thread parse without | Main-thread parse with | Worker time (background) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 240 KB | 12.2 KB | **94.9 %** | 1.0 ms | **0.05 ms** | 2.1 ms |
| 500 | 481 KB | 14.6 KB | **97.0 %** | 2.4 ms | **0.05 ms** | 3.0 ms |
| 1 000 | 963 KB | 19.5 KB | **98.0 %** | 6.0 ms | **0.06 ms** | 5.9 ms |
| 2 000 | 1.93 MB | 30.3 KB | **98.4 %** | 8.3 ms | **0.11 ms** | 13.1 ms |
| 4 000 | 3.88 MB | 51.8 KB | **98.7 %** | 17.3 ms | **0.17 ms** | 21.6 ms |

Reading: the page's main thread receives 94–99 % less data and its JSON
parsing cost drops to effectively zero; the remaining heavy work happens on
the background worker thread.

## Results — DOM & rendering (1 500-turn conversation)

| Metric | Without Lumen | With Lumen | Change |
| --- | ---: | ---: | ---: |
| DOM nodes alive | 23 008 | ~370 | **−98.4 %** |
| Full initial layout | 8.1 ms | ~0.4 ms | **−95 %** |
| Style+layout recalc | 0.01 ms | 0.00 ms | below measurement floor |
| DOM limiter pass | — | 5.7 ms (once) | — |

## Speedup summary (computed from the measured values above)

**Per-conversation-size speedup factors:**

| Messages | Data processed | Main-thread parse work | |
| ---: | ---: | ---: | ---: |
| 250 | 19.7× less (−94.9 %) | 20× less (−95.0 %) | |
| 500 | 32.9× less (−97.0 %) | 48× less (−97.9 %) | |
| 1 000 | 49.4× less (−98.0 %) | 100× less (−99.0 %) | |
| 2 000 | 63.8× less (−98.4 %) | 76× less (−98.7 %) | |
| 4 000 | 74.8× less (−98.7 %) | 102× less (−99.0 %) | |

**What drives perceived lag, and how much of it is removed:**

| Lag source | Removed by Lumen |
| --- | ---: |
| Conversation data over the wire | **−94.9 … −98.7 %** (grows with chat length) |
| Main-thread JSON parsing at load | **−95 … −99 %** (measured; rest moved off-thread) |
| DOM size that layout/paint must maintain | **−98.4 %** (23 008 → ~370 nodes) |
| Per-update style+layout work in long chats | scales with DOM size → **≈ −98 %** |

**One-line summary:** in a maxed-out conversation Lumen cuts the loaded
payload ~75× and the render-tree size ~62×, which removes roughly
**95–99 % of the main-thread work** responsible for load and scroll lag.

## Honest limitations

- Scroll **paint** cost cannot be measured meaningfully in headless Chrome
  (no compositor output); the DOM-node reduction is the honest proxy there.
- The synthetic DOM is simpler than ChatGPT's real one (no React
  reconciliation, simpler styles). Real-chat gains via the same mechanisms
  are therefore expected to be **equal or larger**, not smaller.
- Live signed-in chatgpt.com A/B measurements were not performed (no
  account access from the test environment). Reproduce on your own chat:
  F12 → Performance → record with the extension disabled vs. enabled.

## Reproduce

Benchmark sources live next to this file's repository history
(`bench-payload.js`, `bench-dom.html`, `run-dom-bench.js`).
