# Lumen — Benchmark Results

_Measured: 2026-09-20 · Machine: developer's Windows PC · Node v22.19.0 ·
Chrome 153.0.8010.50 (headless) · Extension build: v3.1.0_

## Methodology

Two synthetic benchmarks with different fidelity levels. Both use
conversation data shaped like ChatGPT's; neither is a live chatgpt.com
measurement.

1. **Payload benchmark** (`bench/bench-payload.js`, Node.js) — executes
   Lumen's **actual shipped trim pipeline**: the real `trimWithKeep` /
   `trimSync` functions are loaded from the shipped `main-world.js` into a
   sandbox and process conversations shaped exactly like ChatGPT's
   `/backend-api/conversation/:id` responses (mapping graph, message nodes,
   markdown/code bodies, ~1.2 KB average text per message). The worker path
   mirrors the shipped `blob:`-worker flow (parse + trim + stringify off the
   main thread). Timings are medians of 5 runs. Keep value = 10 (extension
   default).
2. **DOM benchmark** (`bench/bench-dom.html`, headless Chrome) — a **synthetic
   approximation** of Lumen's rendering-window strategy. It builds a
   ChatGPT-like document (1,000 conversation turns, 4-level container
   nesting, paragraphs, lists, double code blocks — 23,008 DOM nodes,
   ~7 MB of HTML) and applies CSS/markup phases that mirror v3.1's layers:
   the core virtualization CSS, the DOM window limiter (last 10 turns
   participating; older turns hidden with `display:none`, not removed), and
   the optional animations-off toggle measured separately. It estimates
   layout/rendering effects; it does not execute the full shipped content
   script.

## Results — serialized payload & processing

The full conversation body still arrives from ChatGPT's servers unchanged —
Lumen trims it locally. "Payload" below means the serialized conversation
JSON handed to ChatGPT's frontend for parsing.

| Messages | Payload without Lumen | With Lumen | Smaller | Main-thread parse without | Main-thread parse with | Worker time (background) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 240 KB | 12.2 KB | **94.9 %** | 1.3 ms | **0.04 ms** | 2.4 ms |
| 500 | 481 KB | 14.6 KB | **97.0 %** | 2.0 ms | **0.05 ms** | 4.0 ms |
| 1 000 | 963 KB | 19.5 KB | **98.0 %** | 7.0 ms | **0.10 ms** | 9.8 ms |
| 2 000 | 1.93 MB | 30.3 KB | **98.4 %** | 10.3 ms | **0.11 ms** | 11.6 ms |
| 4 000 | 3.88 MB | 51.8 KB | **98.7 %** | 16.7 ms | **0.26 ms** | 25.2 ms |

Reading: the page's main thread receives 94–99 % less serialized
conversation data to parse, and its JSON parsing cost drops to effectively
zero; the remaining heavy work happens on the background worker thread.

## Results — DOM & rendering (1,000-turn conversation, 23,008 nodes)

| Metric | Without Lumen | Core layer | Core + window limiter |
| --- | ---: | ---: | ---: |
| Nodes participating in layout (rest hidden via `display:none`) | 23,008 | 23,008 (CSS-only virtualization) | ~231 (10 of 1,000 turns) |
| Full initial layout (all turns present) | 4.6 ms | — | — |
| One-time windowing pass | — | — | 3.8 ms |
| Height actually participating after windowing | — | — | 1,960 px |
| Per-frame style+layout / scroll samples | below headless measurement floor | below headless measurement floor | below headless measurement floor |

Note on the measurement floor: headless Chrome without a compositor cannot
produce meaningful per-frame paint/scroll timings at this document size; the
node-participation reduction is the honest proxy there. Live scroll smoothness
therefore needs the manual checks in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

## What Lumen reduces

| Cost source | Reduction mechanism |
| --- | --- |
| Serialized conversation payload the frontend must parse | **−94.9 … −98.7 %** local trim (grows with chat length) |
| Main-thread JSON parsing at load | near zero after trim; remaining work moved off-thread |
| Layout/paint node participation in long chats | **−99 %** (23,008 → ~231 participating nodes in the 1,000-turn benchmark) |

**One-line summary:** in the synthetic benchmarks Lumen hands the frontend a
75–99× smaller serialized payload and leaves ~99 % fewer nodes participating
in layout, which removes most of the main-thread work that grows with chat
length.

## Honest limitations

- The full network body is still downloaded — trimming happens locally, so
  these numbers describe **frontend processing cost**, not bandwidth savings.
- Hidden turns remain in the DOM (`display:none`); the DOM win is about
  what layout and paint must process, not about node removal.
- No memory/heap reduction was measured; this document makes no memory
  claims.
- The DOM benchmark is a synthetic approximation (see Methodology): it
  reproduces Lumen's layer strategy, not ChatGPT's production React tree.
  Live results may differ because ChatGPT's production React tree, styles,
  network conditions and account features are more complex than this
  synthetic benchmark.
- Live signed-in chatgpt.com A/B measurements were not performed (no
  account access from the test environment). Reproduce on your own chat:
  F12 → Performance → record with the extension disabled vs. enabled, and
  work through [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

## Reproduce

```bash
node bench/bench-payload.js    # payload trim + parse benchmark (no browser needed)
node bench/run-dom-bench.js    # DOM benchmark via headless Chrome (CHROME_BIN env overrides the binary)
```
