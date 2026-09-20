/**
 * Lumen payload benchmark — real trim pipeline on real schema-shaped data.
 * Loads the ACTUAL shipped main-world.js (via vm sandbox) and measures:
 *   - payload bytes before / after trim
 *   - main-thread JSON.parse time WITHOUT extension (full payload)
 *   - worker roundtrip (parse+trim+stringify) WITH extension
 *   - main-thread JSON.parse time WITH extension (trimmed payload)
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { Worker } = require('worker_threads');

const EXT = path.resolve(__dirname, '..');

/* ── Load the real extension code into a stubbed sandbox ─────────────── */
let src = fs.readFileSync(path.join(EXT, 'src/content/main-world.js'), 'utf8');
src = src.replace(/\}\)\(\);\s*$/, 'globalThis.__t={clampLimit,isMessageNode,isVisibleMessage,buildPath,trimWithKeep,trimSync};})();');
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/bench' },
  history: { pushState: () => {}, replaceState: () => {} },
  Element: { prototype: {} },
  setTimeout, clearTimeout,
  window: null
};
sandbox.window = { addEventListener() {}, postMessage() {}, scrollTo() {}, scrollBy() {}, fetch() { throw new Error('no network'); } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const T = sandbox.__t;

/* ── Realistic ChatGPT-shaped payload builder ────────────────────────── */
function msgText(i) {
  let s = (i % 2 ? 'Sure — here is a detailed breakdown:\n\n' : 'Question about topic ' + i + ':\n\n');
  s += 'This paragraph explains the reasoning in detail with **markdown** and `inline code`, referencing step ' + i + '. '.repeat(8) + '\n\n';
  s += '- point one with enough words to add real weight to the list\n- point two follows here\n- point three closes the set\n\n';
  if (i % 5 === 0) s += '```js\nfunction example' + i + '(x) {\n  const y = x * 2;\n  return y + ' + i + ';\n}\n' + '// stability comment line\n'.repeat(12) + '```\n\n';
  s += 'Closing summary sentence with a [link](https://example.com) and final thoughts. '.repeat(3);
  return s;
}

function buildPayload(n) {
  const mapping = {};
  let prev = null, id;
  for (let i = 0; i < n; i++) {
    id = 'msg-' + i;
    mapping[id] = {
      id, parent: prev, children: [],
      message: {
        id: 'm-' + i,
        author: { role: i % 2 ? 'assistant' : 'user', name: i % 2 ? undefined : 'User', metadata: {} },
        create_time: 1700000000 + i * 7,
        update_time: i % 2 ? 1700000004 + i * 7 : undefined,
        content: { content_type: 'text', parts: [msgText(i)] },
        status: i % 2 ? 'finished_successfully' : 'finished_successfully',
        end_turn: i % 2 ? null : undefined,
        weight: i % 2 ? 1 : 0,
        metadata: { message_type: i % 2 ? 'model' : 'user', model_slug: i % 2 ? 'gpt-4o' : undefined, finish_details: i % 2 ? { type: 'stop' } : undefined, citations: [] },
        recipient: 'all'
      }
    };
    if (prev) mapping[prev].children.push(id);
    prev = id;
  }
  return {
    title: 'Benchmark conversation', create_time: 1700000000, update_time: 1700000000 + n * 7,
    mapping, current_node: 'msg-' + (n - 1), conversation_id: 'bench', sidebar_project_id: null,
    plugin_ids: null, default_model_slug: 'gpt-4o', gizmo_id: null, is_archived: false,
    safe_urls: ['https://example.com'], message_ids: Object.keys(mapping)
  };
}

/* ── Worker (mirrors the shipped worker: parse+trim+stringify off-thread) */
const workerSrc = `
const { parentPort } = require('worker_threads');
const clampLimit = ${T.clampLimit.toString()};
const isMessageNode = ${T.isMessageNode.toString()};
const isVisibleMessage = ${T.isVisibleMessage.toString()};
const buildPath = ${T.buildPath.toString()};
const trimWithKeep = ${T.trimWithKeep.toString()};
const trimSync = ${T.trimSync.toString()};
parentPort.onmessage = (e) => {
  const t0 = performance.now();
  const r = trimSync(e.data.text, e.data.keep);
  parentPort.postMessage({ id: e.data.id, workerMs: performance.now() - t0, text: r ? r.text : null, passthrough: !!(r && r.passthrough) });
};
`;
const workerPath = path.join(__dirname, 'lumen-bench-worker.js');
fs.writeFileSync(workerPath, workerSrc);

const worker = new Worker(workerPath);
const median = arr => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];

function measure(fn, runs = 5) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = fn();
    samples.push(performance.now() - t0);
    if (i === 0 && r === undefined && false) {}
  }
  return median(samples);
}

function workerTrim(text, keep) {
  return new Promise(resolve => {
    const id = Math.random();
    const on = (e) => {
      if (e.id !== id) return;
      worker.off('message', on);
      resolve(e);
    };
    worker.on('message', on);
    worker.postMessage({ id, text, keep });
  });
}

(async () => {
  const KEEP = 10; /* the extension default */
  console.log('n,msgBytes,fullParseMs,noExtParseMs?->,workerMs,withExtParseMs,fullKB,trimmedKB,savedPct');

  for (const n of [250, 500, 1000, 2000, 4000]) {
    const payload = buildPayload(n);
    const fullText = JSON.stringify(payload);
    const fullBytes = Buffer.byteLength(fullText);

    /* WITHOUT extension: page must parse the entire payload on its main thread */
    const fullParseMs = measure(() => { JSON.parse(fullText); });

    /* WITH extension: worker does parse+trim+stringify, page parses small output */
    const r = await workerTrim(fullText, KEEP);
    const trimmedText = r.text;
    const trimmedBytes = Buffer.byteLength(trimmedText || 'null');
    const withExtParseMs = measure(() => { JSON.parse(trimmedText); });

    const savedPct = (100 * (1 - trimmedBytes / fullBytes)).toFixed(1);
    console.log([n, fullBytes, fullParseMs.toFixed(1), r.workerMs.toFixed(1), withExtParseMs.toFixed(2), (fullBytes / 1024).toFixed(0), (trimmedBytes / 1024).toFixed(1), savedPct].join(','));
  }

  await worker.terminate();
})();
