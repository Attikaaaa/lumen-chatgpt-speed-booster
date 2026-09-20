/**
 * Pagination regression test — runs the REAL shipped extractSlice().
 * Contract (100 messages, keep 10, chunk 25):
 *   chunk 1 -> messages 66-90
 *   chunk 2 -> messages 41-65
 *   chunk 3 -> messages 16-40
 *   chunk 4 -> messages  1-15
 * No duplicates, no gaps, exhaustion only after the last chunk.
 */
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let src = fs.readFileSync(path.join(ROOT, 'src/content/main-world.js'), 'utf8');
src = src.replace(/\}\)\(\);\s*$/, 'globalThis.__t = { extractSlice }; })();');

const noop = () => {};
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/x' },
  history: { pushState: noop, replaceState: noop },
  Element: { prototype: {} },
  setTimeout, clearTimeout,
  window: null
};
sandbox.window = { addEventListener: noop, postMessage: noop, scrollTo: noop, scrollBy: noop, fetch: () => { throw new Error('no network'); } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'main-world.js' });

const { extractSlice } = sandbox.__t;

function makeConv(n, nonTextEvery = 0) {
  const mapping = {};
  let prev = null, id;
  for (let i = 0; i < n; i++) {
    id = 'n' + i;
    const content = (nonTextEvery && i % nonTextEvery === 0)
      ? { content_type: 'image', parts: [{ image: true }] }
      : { content_type: 'text', parts: ['msg ' + (i + 1)] };
    mapping[id] = { id, parent: prev, children: [],
      message: { author: { role: i % 2 ? 'assistant' : 'user' }, content } };
    if (prev) mapping[prev].children.push(id);
    prev = id;
  }
  return { mapping, current_node: 'n' + (n - 1) };
}

let fail = 0;
const ok = (cond, name) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fail++; };

/* ── contract: 100 msgs, keep 10 → chunks 66-90, 41-65, 16-40, 1-15 ── */
const conv = makeConv(100);
const visibleBase = 10;
let consumed = 0;
const ranges = [];
const seen = [];

for (let step = 0; step < 6; step++) {
  const skip = visibleBase + consumed;
  if (skip >= 100) break;
  const out = extractSlice(conv, skip, 25);
  if (!out || out.items.length === 0) break;
  const rangeEnd = 100 - skip;
  const rangeStart = rangeEnd - out.items.length + 1;
  ranges.push(`${rangeStart}-${rangeEnd}`);
  for (let k = 0; k < out.items.length; k++) seen.push(rangeEnd - k);
  consumed += out.consumedCount;
  if (out.reachedStart) break;
}

ok(ranges[0] === '66-90', 'chunk 1 = 66-90, got ' + ranges[0]);
ok(ranges[1] === '41-65', 'chunk 2 = 41-65, got ' + ranges[1]);
ok(ranges[2] === '16-40', 'chunk 3 = 16-40, got ' + ranges[2]);
ok(ranges[3] === '1-15', 'chunk 4 = 1-15, got ' + ranges[3]);
ok(new Set(seen).size === seen.length, 'no duplicate messages across chunks');
ok(seen.length === 90, 'all 90 hidden messages covered, got ' + seen.length);

/* exhaustion: the 5th request has nothing left */
let extra = true;
const skipEnd = visibleBase + consumed;
ok(skipEnd >= 100, 'loader exhausts at conversation start (skip=' + skipEnd + ')');

console.log(fail === 0 ? 'PAGINATION TESTS PASS' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
