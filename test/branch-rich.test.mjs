/**
 * Branch preservation + rich ghost renderer tests.
 * Runs the REAL trimWithKeep/extractSlice from main-world.js and the REAL
 * renderRich from content.js inside a stubbed sandbox.
 */
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const noop = () => {};

function makeSandbox() {
  const sb = {
    console,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/x' },
    history: { pushState: noop, replaceState: noop },
    Element: { prototype: {} },
    setTimeout, clearTimeout, structuredClone: v => JSON.parse(JSON.stringify(v)), setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
    Worker: undefined,
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x' },
    window: null
  };
  sb.window = {
    addEventListener: noop, postMessage: noop, scrollTo: noop, scrollBy: noop,
    fetch: () => { throw new Error('no network'); }
  };
  vm.createContext(sb);
  return sb;
}

let fail = 0;
const ok = (cond, name) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fail++; };

/* ── load main-world ── */
let mw = fs.readFileSync(path.join(ROOT, 'src/content/main-world.js'), 'utf8');
mw = mw.replace(/\}\)\(\);\s*$/, 'globalThis.__mw = { trimSync, extractSlice }; })();');
const sb1 = makeSandbox();
vm.createContext(sb1);
vm.runInContext(mw, sb1, { filename: 'main-world.js' });
const { trimSync, extractSlice } = sb1.__mw;

/* ── load content.js (renderer) ── */
let ct = fs.readFileSync(path.join(ROOT, 'src/content/content.js'), 'utf8');
ct = ct.replace(/\}\)\(\);\s*$/, 'globalThis.__ct = { renderRich }; })();');
const sb2 = makeSandbox();
vm.createContext(sb2);
vm.runInContext(ct, sb2, { filename: 'content.js' });
const { renderRich } = sb2.__ct;

/* ── branch-safe trim ── */
function makeBranched() {
  const mapping = {};
  const add = (id, parent, role, text) => {
    mapping[id] = { id, parent, children: [],
      message: { author: { role }, content: { content_type: 'text', parts: [text] } } };
    if (parent) mapping[parent].children.push(id);
    return id;
  };
  const u0 = add('u0', null, 'user', 'question');
  const a1 = add('a1', u0, 'assistant', 'answer v1');
  const a1b = add('a1b', u0, 'assistant', 'answer v2'); /* alternate branch */
  const u2 = add('u2', a1, 'user', 'follow-up');
  return { mapping, current_node: u2 };
}

const payload = makeBranched();
const full = JSON.stringify(payload);
const trimmed = trimSync(full, 2); /* keep 2: u0 + a1 */
const out = JSON.parse(trimmed.text);

ok(out.mapping.a1b !== undefined, 'sibling branch node kept as stub');
ok(out.mapping.a1b.parent === null, 'boundary branch stub is root-level');
ok(out.mapping.a1b.children.length === 0, 'branch stub subtree truncated');

/* ── renderRich escaping + formatting ── */
const evil = '<script>alert(1)</script> **bold** `code` [x](https://example.com)';
const html = renderRich(evil);
ok(!html.includes('<script>'), 'script tags escaped');
ok(html.includes('&lt;script&gt;'), 'angle brackets escaped');
ok(html.includes('<strong>bold</strong>'), 'bold rendered');
ok(html.includes('<code>code</code>'), 'inline code rendered');
ok(html.includes('href="https://example.com"'), 'link kept');

/* fenced code */
const codeHtml = renderRich('```js\nconst a = 1;\n```');
ok(codeHtml.includes('<pre><code>') && codeHtml.includes('const a = 1;'), 'fenced code rendered');

console.log(fail === 0 ? 'BRANCH/RICH TESTS PASS' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
