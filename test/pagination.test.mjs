/**
 * Pagination regression tests — run the REAL shipped extractSlice() and
 * simulate the content-script loader decision (exhausted only when the
 * traversal consumed zero bubbles).
 *
 * Contract (100 messages, 10 visible, chunk 25):
 *   chunk 1 -> 66-90   chunk 2 -> 41-65
 *   chunk 3 -> 16-40   chunk 4 -> 1-15
 */
import { loadMainWorld, makeConv, makeReporter } from './helpers.mjs';

const ok = makeReporter('pagination');
const { extractSlice } = loadMainWorld();

const CHUNK = 25;

/**
 * Simulates loadOlderChunk()'s pagination loop with the shipped decision:
 * exhausted ⇔ consumedCount === 0 (or reachedStart after injecting).
 * Returns { ranges, seen, exhausted, steps }.
 */
function paginate(total, visibleBase, conv, cap = 50) {
  let consumed = 0;
  let injected = 0;
  let exhausted = false;
  const ranges = [];
  const seen = [];
  let steps = 0;

  while (!exhausted && steps++ < cap) {
    const skip = visibleBase + consumed;
    const out = extractSlice(conv, skip, CHUNK);
    if (!out) { exhausted = true; break; }

    /* shipped decision: zero consumed bubbles ⇒ exhausted (start reached
       or skip beyond the end). A full chunk of non-text turns has
       consumedCount > 0 and MUST continue. */
    if (!out.consumedCount) { exhausted = true; break; }
    consumed += out.consumedCount;

    if (out.items.length > 0) {
      const rangeEnd = total - skip;
      const rangeStart = rangeEnd - out.items.length + 1;
      ranges.push(rangeStart + '-' + rangeEnd);
      for (let k = 0; k < out.items.length; k++) seen.push(rangeEnd - k);
      injected += out.items.length;
    }

    if (out.reachedStart) exhausted = true;
  }
  return { ranges, seen, exhausted, injected, consumed, steps };
}

/* ── 1. exact 100/10 sequence ────────────────────────────────────────── */
{
  const total = 100;
  const conv = makeConv(total);
  const p = paginate(total, 10, conv);
  ok(p.ranges[0] === '66-90', 'chunk 1 = 66-90, got ' + p.ranges[0]);
  ok(p.ranges[1] === '41-65', 'chunk 2 = 41-65, got ' + p.ranges[1]);
  ok(p.ranges[2] === '16-40', 'chunk 3 = 16-40, got ' + p.ranges[2]);
  ok(p.ranges[3] === '1-15', 'chunk 4 = 1-15, got ' + p.ranges[3]);
  ok(new Set(p.seen).size === p.seen.length, 'no duplicates');
  ok(p.seen.length === 90, 'all 90 hidden messages covered');
  ok(p.exhausted, 'loader exhausts exactly after the final chunk');
}

/* ── 2. every 5th message non-text ───────────────────────────────────── */
{
  const total = 100;
  const conv = makeConv(total, { nonTextEvery: 5 });
  const p = paginate(total, 10, conv);
  ok(new Set(p.seen).size === p.seen.length, 'every-5th: no duplicates');
  ok(p.seen.length === 72, 'every-5th: all 72 text messages covered (90 hidden, 18 non-text), got ' + p.seen.length);
  ok(p.exhausted, 'every-5th: exhausts at start');
}

/* ── 3. an entire 25-message chunk non-text → NOT exhausted ──────────── */
{
  const total = 100;
  /* hidden range is messages 1-90 (indexes 0-89). Make indexes 30-54
     non-text → that is exactly chunk 3's slice (16-40) plus neighbors.
     Instead, target precisely one chunk: chunk 1 covers messages 66-90 =
     indexes 65-89. */
  const conv = makeConv(total, { nonTextRange: [65, 90] });
  const p = paginate(total, 10, conv);
  ok(p.ranges.length === 3, 'all-text chunks still produce ranges (3), got ' + p.ranges.length);
  ok(!p.ranges.some(r => r === '66-90'), 'fully non-text chunk renders nothing but is skipped');
  ok(p.consumed === 90, 'consumed advanced THROUGH the non-text chunk (90), got ' + p.consumed);
  ok(p.exhausted, 'pagination continues past the empty-render chunk and exhausts at start');
  ok(p.seen.length === 65, 'the other 65 text messages all rendered');
}

/* ── 4. consecutive non-text-heavy chunks ────────────────────────────── */
{
  const total = 100;
  const conv = makeConv(total, { nonTextRange: [30, 90] }); /* 60 straight non-text */
  const p = paginate(total, 10, conv);
  ok(p.consumed === 90, 'two consecutive non-text chunks traversed, got ' + p.consumed);
  ok(p.seen.length === 30, 'remaining 30 text messages rendered');
  ok(p.exhausted, 'exhausts at start after non-text-heavy stretch');
}

/* ── 5. boundary sizes: 10, 11, 35, 60, 100 (10 visible each) ────────── */
for (const total of [10, 11, 35, 60, 100]) {
  const conv = makeConv(total);
  const visibleBase = Math.min(10, total);
  const p = paginate(total, visibleBase, conv);
  const hidden = total - visibleBase;
  ok(new Set(p.seen).size === p.seen.length, 'boundary ' + total + ': no duplicates');
  ok(p.seen.length === hidden, 'boundary ' + total + ': all ' + hidden + ' hidden covered, got ' + p.seen.length);
  ok(p.exhausted, 'boundary ' + total + ': exhausts cleanly');
}

/* ── 6. skip beyond the end exhausts immediately (no infinite loop) ──── */
{
  const conv = makeConv(20);
  const p = paginate(20, 25, conv); /* visibleBase exceeds total */
  ok(p.exhausted && p.steps === 1, 'over-skip exhausts in one step (no loop)');
}

ok.done();
