# Lumen — Benchmark Results

_Measured: 2026-09-20 · Machine: developer's Windows PC · Node v22.19.0 ·
Chrome 153.0.8010.50 (headless) · Extension build: v3.1.0 (trim pipeline
unchanged since measurement)_

## Methodology

Two synthetic benchmarks, both running the **actual shipped trim pipeline** —
loaded from the shipped `main-world.js` into a sandbox; no re-implementations,
no estimates. These are synthetic approximations of ChatGPT's data shapes,
not live chatgpt.com measurements.

1. **Payload benchmark** (Node.js): conversations shaped exactly like
   ChatGPT's `/backend-api/conversation/:id` responses (mapping graph,
   message nodes, markdown/code bodies, ~1.2 KB average text per message)
   are processed by the real `trimWithKeep`/`trimSync` pipeline from the
   shipped file. The worker path mirrors the shipped `blob:`-worker flow
   (parse + trim + stringify off the main thread). Timings are medians of
   5 runs. Keep value = 10 (extension default).
2. **DOM benchmark** (headless Chrome): 1 500 conversation turns built with
   ChatGPT-like markup (4-level container nesting, paragraphs, lists,
   double code blocks — 23 008 DOM nodes total, ~7 MB of HTML). Measures
   full-tree layout time and style+layout recalc cost without the
   extension, and with Lumen's DOM limiter active (last 10 turns
   participating; older turns are hidden with `display:none`, not removed
   from the DOM).

## Results — serialized payload & processing

The full conversation body still arrives from ChatGPT's servers unchanged —
Lumen trims it locally. "Payload" below means the serialized conversation
JSON handed to ChatGPT's frontend for parsing.

| Messages | Payload without Lumen | With Lumen | Smaller | Main-thread parse without | Main-thread parse with | Worker time (background) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 240 KB | 12.2 KB | **94.9 %** | 1.0 ms | **0.05 ms** | 2.1 ms |
| 500 | 481 KB | 14.6 KB | **97.0 %** | 2.4 ms | **0.05 ms** | 3.0 ms |
| 1 000 | 963 KB | 19.5 KB | **98.0 %** | 6.0 ms | **0.06 ms** | 5.9 ms |
| 2 000 | 1.93 MB | 30.3 KB | **98.4 %** | 8.3 ms | **0.11 ms** | 13.1 ms |
| 4 000 | 3.88 MB | 51.8 KB | **98.7 %** | 17.3 ms | **0.17 ms** | 21.6 ms |

Reading: the page's main thread receives 94–99 % less serialized
conversation data to parse, and its JSON parsing cost drops to effectively
zero; the remaining heavy work happens on the background worker thread.

## Results — DOM & rendering (1 500-turn conversation)

| Metric | Without Lumen | With Lumen | Change |
| --- | ---: | ---: | ---: |
| Nodes participating in layout (rest hidden via `display:none`) | 23 008 | ~370 | **−98.4 %** |
| Full initial layout | 8.1 ms | ~0.4 ms | **−95 %** |
| Style+layout recalc | 0.01 ms | 0.00 ms | below measurement floor |
| DOM limiter pass | — | 5.7 ms (once) | — |

## Speedup summary (computed from the measured values above)

**Per-conversation-size speedup factors:**

| Messages | Serialized payload processed by the frontend | Main-thread parse work | |
| ---: | ---: | ---: | ---: |
| 250 | 19.7× less (−94.9 %) | 20× less (−95.0 %) | |
| 500 | 32.9× less (−97.0 %) | 48× less (−97.9 %) | |
| 1 000 | 49.4× less (−98.0 %) | 100× less (−99.0 %) | |
| 2 000 | 63.8× less (−98.4 %) | 76× less (−98.7 %) | |
| 4 000 | 74.8× less (−98.7 %) | 102× less (−99.0 %) | |

**What drives perceived lag, and how much of it Lumen removes:**

| Lag source | Removed by Lumen |
| --- | ---: |
| Serialized conversation payload the frontend must parse | **−94.9 … −98.7 %** (grows with chat length) |
| Main-thread JSON parsing at load | **−95 … −99 %** (measured; rest moved off-thread) |
| Layout/paint node participation in long chats | **−98.4 %** (23 008 → ~370 nodes participate) |
| Per-update style+layout work in long chats | scales with participation → **≈ −98 %** |

**One-line summary:** in a maxed-out conversation Lumen hands the frontend a
~75× smaller serialized payload and leaves ~62× fewer nodes participating in
layout, which removes roughly **95–99 % of the main-thread work** responsible
for load and scroll lag.

## Honest limitations

- The full network body is still downloaded — trimming happens locally, so
  these numbers describe **frontend processing cost**, not bandwidth savings.
- Hidden turns remain in the DOM (`display:none`); the DOM win is about
  what layout and paint must process, not about node removal.
- Scroll **paint** cost cannot be measured meaningfully in headless Chrome
  (no compositor output); node participation is the honest proxy there.
- The synthetic DOM is simpler than ChatGPT's real one (no React
  reconciliation, simpler styles). Real-chat gains via the same mechanisms
  are expected to be **equal or larger**, not smaller.
- Live signed-in chatgpt.com A/B measurements were not performed (no
  account access from the test environment). Reproduce on your own chat:
  F12 → Performance → record with the extension disabled vs. enabled.

## Reproduce

```bash
node bench/bench-payload.js    # payload trim + parse benchmark (no browser needed)
node bench/run-dom-bench.js    # DOM benchmark via headless Chrome (CHROME_BIN env overrides the binary)
```
