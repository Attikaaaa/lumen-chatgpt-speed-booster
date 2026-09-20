/**
 * Shared test helpers: run shipped scripts inside a minimal sandbox and
 * read their test-hook exports. No dependencies.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Returns the byte-identical settings-model block shipped in a file. */
export function settingsModelBlock(src) {
  const match = src.match(/\/\* LUMEN-SETTINGS-MODEL-START[\s\S]*?LUMEN-SETTINGS-MODEL-END \*\//);
  return match ? match[0] : null;
}

/**
 * Runs main-world.js in a sandbox with browser stubs and returns its
 * __LUMEN_TEST__ export.
 */
export function loadMainWorld() {
  const noop = () => {};
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/x' },
    history: { pushState: noop, replaceState: noop },
    Element: { prototype: {} },
    Headers: class { constructor() {} delete() {} },
    Response: class {},
    Request: class { constructor(u) { this.url = String(u); } },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL,
    Worker: class { postMessage() {} terminate() {} },
    setTimeout, clearTimeout,
    window: null
  };
  sandbox.window = {
    __lumenMainLoaded: undefined,
    addEventListener: noop,
    postMessage: noop,
    scrollTo: noop,
    scrollBy: noop,
    fetch: () => { throw new Error('no network in tests'); }
  };
  sandbox.globalThis = sandbox;
  sandbox.__LUMEN_EXPOSE_TEST_HOOKS__ = true;
  vm.createContext(sandbox);
  vm.runInContext(readSrc('src/content/main-world.js'), sandbox, { filename: 'main-world.js' });
  return sandbox.__LUMEN_TEST__;
}

/**
 * Runs content.js in a sandbox (init fails silently without chrome) and
 * returns its __LUMEN_TEST_CONTENT__ export.
 */
export function loadContent() {
  const noop = () => {};
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/x', pathname: '/c/x' },
    URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    structuredClone,
    requestAnimationFrame: noop,
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    window: { addEventListener: noop, dispatchEvent: noop, scrollY: 0, innerHeight: 800 },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { appendChild: noop, scrollHeight: 0 },
      readyState: 'complete',
      addEventListener: noop
    },
    window: null
  };
  sandbox.window = sandbox; /* content.js uses bare window.* */
  sandbox.globalThis = sandbox;
  sandbox.__LUMEN_EXPOSE_TEST_HOOKS__ = true;
  vm.createContext(sandbox);
  vm.runInContext(readSrc('src/content/content.js'), sandbox, { filename: 'content.js' });
  return sandbox.__LUMEN_TEST_CONTENT__;
}

/**
 * Runs service-worker.js with a chrome stub and returns __LUMEN_TEST_SW__.
 * @param {Function[]} [dnrCalls] collector for updateEnabledRulesets options
 */
export function loadServiceWorker(dnrCalls = []) {
  const noop = () => {};
  const listeners = { onInstalled: [], onChanged: [] };
  const chromeStub = {
    storage: {
      sync: { get: async keys => ({}), set: async () => {} },
      onChanged: { addListener: fn => listeners.onChanged.push(fn) }
    },
    runtime: {
      onInstalled: { addListener: fn => listeners.onInstalled.push(fn) },
      setUninstallURL: noop
    },
    declarativeNetRequest: {
      updateEnabledRulesets: opts => dnrCalls.push(opts)
    },
    tabs: { query: async () => [] },
    scripting: { insertCSS: async () => {}, executeScript: async () => {} }
  };
  const sandbox = {
    console, chrome: chromeStub, setTimeout, clearTimeout, URL,
    globalThis: null
  };
  sandbox.globalThis = sandbox;
  sandbox.__LUMEN_EXPOSE_TEST_HOOKS__ = true;
  vm.createContext(sandbox);
  vm.runInContext(readSrc('src/background/service-worker.js'), sandbox, { filename: 'service-worker.js' });
  return { hooks: sandbox.__LUMEN_TEST_SW__, listeners, chrome: chromeStub };
}

/** Builds a linear conversation payload with n visible messages. */
export function makeConv(n, opts = {}) {
  const nonTextEvery = opts.nonTextEvery || 0;
  const nonTextRange = opts.nonTextRange || null;
  const mapping = {};
  let prev = null;
  let id;
  for (let i = 0; i < n; i++) {
    id = 'n' + i;
    const inNonTextRange = nonTextRange && i >= nonTextRange[0] && i < nonTextRange[1];
    const nonText = (nonTextEvery && i % nonTextEvery === 0) || inNonTextRange;
    const content = nonText
      ? { content_type: 'image', parts: [{ image: true }] }
      : { content_type: 'text', parts: ['msg ' + (i + 1)] };
    mapping[id] = {
      id, parent: prev, children: [],
      message: { author: { role: i % 2 ? 'assistant' : 'user' }, content }
    };
    if (prev) mapping[prev].children.push(id);
    prev = id;
  }
  return { mapping, current_node: 'n' + (n - 1) };
}

/** Shared PASS/FAIL reporter. @returns {Function} ok(cond, name) */
export function makeReporter(suite) {
  let fail = 0;
  const ok = (cond, name) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' [' + suite + '] ' + name);
    if (!cond) fail++;
  };
  ok.done = () => {
    console.log(fail === 0 ? suite.toUpperCase() + ' PASS' : fail + ' ' + suite.toUpperCase() + ' FAILURES');
    process.exit(fail === 0 ? 0 : 1);
  };
  return ok;
}
