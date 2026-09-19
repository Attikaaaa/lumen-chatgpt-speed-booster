/**
 * Lumen — ChatGPT Speed Booster · main-world bridge.
 * Trims conversation fetch payloads to recent messages (off the main
 * thread), forces instant programmatic scrolling, and publishes status
 * to the isolated content script.
 */

(() => {
  'use strict';

  /* Guard against double injection (manifest + programmatic). */
  if (window.__lumenMainLoaded) return;
  window.__lumenMainLoaded = true;

  /* ══ Constants ══════════════════════════════════════════════════════ */

  /** localStorage key under which the content script publishes the config. */
  const CONFIG_KEY = 'lumen_config_v1';

  /** Default configuration (mirrors the popup's defaults). */
  const DEFAULTS = Object.freeze({ enabled: true, limit: 10 });

  /** Absolute ceiling for kept messages — a safety clamp, not a feature. */
  const KEEP_HARD_CAP = 5000;

  /** Identifies every postMessage emitted by this script. */
  const MESSAGE_SOURCE = 'lumen_main';

  /** Worker round-trip watchdog. */
  const WORKER_TIMEOUT_MS = 5000;

  /* ══ State ══════════════════════════════════════════════════════════ */

  let settings = loadSettings();

  /** Latest rendering statistics, published to the content script. */
  let lastStatus = {
    layoutSupported: null,
    totalMessages: 0,
    renderedMessages: 0,
    hiddenMessages: 0,
    hasOlderMessages: false,
    active: false
  };

  /* ══ Generic helpers ════════════════════════════════════════════════ */

  /** Clamps `value` into the [min, max] interval. */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Applies defaults and type-checks a raw settings object. */
  function sanitize(raw) {
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      limit: clamp(Number(raw.limit) || DEFAULTS.limit, 1, 200)
    };
  }

  /** Reads the configuration published by the isolated content script. */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return { ...DEFAULTS };
      return sanitize(JSON.parse(raw));
    } catch {
      return { ...DEFAULTS };
    }
  }

  /* ══ Status publishing ══════════════════════════════════════════════ */

  /**
   * Merges a patch into the status snapshot and publishes it.
   * @param {Partial<typeof lastStatus>} patch
   */
  function postStatus(patch) {
    lastStatus = {
      ...lastStatus,
      ...patch,
      active: Boolean(settings.enabled)
    };
    window.postMessage(
      { source: MESSAGE_SOURCE, type: 'lumen-status', payload: lastStatus },
      location.origin
    );
  }

  /* ══ Conversation trimming (pure — safe for the worker) ═════════════ */

  /**
   * True when the node carries an actual chat message.
   * @param {*} node
   * @returns {boolean}
   */
  function isMessageNode(node) {
    return Boolean(node && typeof node === 'object' && node.message && typeof node.message === 'object');
  }

  /**
   * True when the message was written by a human or the model.
   * @param {*} node
   * @returns {boolean}
   */
  function isVisibleMessage(node) {
    if (!isMessageNode(node)) return false;
    const role = node.message.author && node.message.author.role;
    return role === 'user' || role === 'assistant';
  }

  /**
   * Walks the parent chain from `currentNodeId` back to the root.
   * @param {Record<string, {parent: string|null}>} mapping
   * @param {string} currentNodeId
   * @returns {string[]} path from root to the current node
   */
  function buildPath(mapping, currentNodeId) {
    const path = [];
    const guard = new Set();
    let id = currentNodeId;
    while (id && mapping[id] && !guard.has(id)) {
      guard.add(id);
      path.unshift(id);
      id = mapping[id].parent;
    }
    return path;
  }

  /**
   * Builds a trimmed copy of a conversation payload, keeping only the last
   * `keep` visible messages. Pure: mutates nothing, safe inside a worker.
   *
   * @param {*} payload      parsed conversation response
   * @param {number} keep    how many recent messages to keep
   * @returns {{passthrough: true, status: object}
   *         | {status: object, json: object}
   *         | null}          null when the payload is not a conversation
   */
  function trimWithKeep(payload, keep) {
    if (!payload || typeof payload !== 'object' || !payload.mapping || !payload.current_node) {
      return null;
    }

    const mapping = payload.mapping;
    const path = buildPath(mapping, payload.current_node);
    if (path.length === 0) return null;

    const bubblePath = path.filter(id => isVisibleMessage(mapping[id]));
    const renderedBubbles = Math.min(bubblePath.length, keep);
    const hidden = Math.max(0, bubblePath.length - renderedBubbles);

    const status = {
      layoutSupported: true,
      totalMessages: bubblePath.length,
      renderedMessages: renderedBubbles,
      hiddenMessages: hidden,
      hasOlderMessages: hidden > 0
    };

    /* Nothing to trim — let the original response pass through untouched. */
    if (bubblePath.length <= keep) {
      return { passthrough: true, status };
    }

    const firstKept = bubblePath[bubblePath.length - keep];
    const keptPath = path.slice(path.indexOf(firstKept) >= 0 ? path.indexOf(firstKept) : 0);
    const keptSet = new Set(keptPath);
    const newMapping = {};

    for (let i = 0; i < keptPath.length; i++) {
      const id = keptPath[i];
      const src = mapping[id];
      if (!src) continue;

      const children = Array.isArray(src.children)
        ? src.children.filter(childId => keptSet.has(childId))
        : [];

      let parent = src.parent;
      if (i === 0) {
        parent = null;
      } else if (!keptSet.has(parent)) {
        parent = keptPath[i - 1] || null;
      }

      /* Copy a node only when its shape actually changes — this keeps the
         rebuild cheap even for very wide mapping objects. */
      const childrenChanged = children.length !== (Array.isArray(src.children) ? src.children.length : 0);
      newMapping[id] = childrenChanged || parent !== src.parent
        ? Object.assign({}, src, { children, parent })
        : src;
    }

    return {
      status,
      json: {
        ...payload,
        mapping: newMapping,
        current_node: keptSet.has(payload.current_node) ? payload.current_node : keptPath[keptPath.length - 1],
        root: keptPath[0]
      }
    };
  }

  /* ══ Off-main-thread trimming ═══════════════════════════════════════ */

  /**
   * Synchronous fallback used when the worker is unavailable or times out.
   * @param {string} text  raw response body
   * @param {number} keep
   * @returns {{passthrough?: boolean, status: object, text?: string} | null}
   */
  function trimSync(text, keep) {
    try {
      const trimmed = trimWithKeep(JSON.parse(text), keep);
      if (!trimmed) return null;
      if (trimmed.passthrough) return { passthrough: true, status: trimmed.status };
      return { status: trimmed.status, text: JSON.stringify(trimmed.json) };
    } catch {
      return null;
    }
  }

  let trimWorker = null;
  let trimWorkerDead = false;
  let trimJobId = 0;

  /** @type {Map<number, {resolve: Function, timer: number}>} */
  const trimJobs = new Map();

  /** Lazily boots the trimming worker from an inline blob. */
  function ensureTrimWorker() {
    if (trimWorker || trimWorkerDead) return;
    try {
      const handler = `
        self.onmessage = (event) => {
          const data = event.data;
          try {
            const result = trimWithKeep(JSON.parse(data.text), data.keep);
            if (!result) { self.postMessage({ id: data.id, ok: true, missing: true }); return; }
            if (result.passthrough) {
              self.postMessage({ id: data.id, ok: true, passthrough: true, status: result.status });
              return;
            }
            self.postMessage({ id: data.id, ok: true, status: result.status, text: JSON.stringify(result.json) });
          } catch (error) {
            self.postMessage({ id: data.id, ok: false });
          }
        };
      `;
      const source = [clamp, isMessageNode, isVisibleMessage, buildPath, trimWithKeep]
        .map(fn => fn.toString())
        .join('\n') + '\n' + handler;

      const blob = new Blob([source], { type: 'application/javascript' });
      trimWorker = new Worker(URL.createObjectURL(blob));

      trimWorker.onmessage = event => {
        const job = trimJobs.get(event.data.id);
        if (!job) return;
        trimJobs.delete(event.data.id);
        clearTimeout(job.timer);
        job.resolve(event.data);
      };

      trimWorker.onerror = () => {
        trimWorkerDead = true;
        try { trimWorker.terminate(); } catch { /* already gone */ }
        trimWorker = null;
      };
    } catch {
      trimWorkerDead = true;
      trimWorker = null;
    }
  }

  /**
   * Trims a raw response body, preferring the worker and always resolving.
   * @param {string} text
   * @param {number} keep
   * @returns {Promise<{passthrough?: boolean, status: object, text?: string} | null>}
   */
  function trimViaWorker(text, keep) {
    return new Promise(resolve => {
      ensureTrimWorker();
      if (!trimWorker) {
        resolve(trimSync(text, keep));
        return;
      }

      const id = ++trimJobId;
      const timer = setTimeout(() => {
        if (trimJobs.delete(id)) resolve(trimSync(text, keep));
      }, WORKER_TIMEOUT_MS);

      trimJobs.set(id, {
        timer,
        resolve: data => {
          if (!data.ok) return resolve(trimSync(text, keep));
          if (data.missing) return resolve(null);
          if (data.passthrough) return resolve({ passthrough: true, status: data.status });
          resolve({ status: data.status, text: data.text });
        }
      });

      trimWorker.postMessage({ id, text, keep });
    });
  }

  /* ══ Fetch interception ═════════════════════════════════════════════ */

  /**
   * True for single-conversation GET requests (the heavy payloads).
   * @param {string} url
   * @param {string} method
   * @returns {boolean}
   */
  function isConversationGet(url, method) {
    return (
      method === 'GET' &&
      /\/backend-api\/(f\/)?conversation\//.test(url) &&
      !/\/backend-api\/(f\/)?conversations(\/|\?|$)/.test(url)
    );
  }

  /** Installs the trimming fetch wrapper exactly once. */
  function patchFetch() {
    if (window.__lumenFetchPatched) return;
    window.__lumenFetchPatched = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      const url = input instanceof Request ? input.url : String(input);
      const method = (init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();

      if (!(settings.enabled && isConversationGet(url, method))) {
        return originalFetch(...args);
      }

      const response = await originalFetch(...args);

      try {
        const text = await response.clone().text();
        const keep = clamp(settings.limit, 1, KEEP_HARD_CAP);
        const trimmed = await trimViaWorker(text, keep);

        if (!trimmed) {
          postStatus({ layoutSupported: false });
          return response;
        }

        postStatus(trimmed.status);

        /* Nothing trimmed — hand back the pristine response. */
        if (trimmed.passthrough) return response;

        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');

        return new Response(trimmed.text, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      } catch {
        postStatus({ layoutSupported: false });
        return response;
      }
    };
  }

  /* ══ Instant programmatic scrolling ═════════════════════════════════ */

  /* Rewrite JS-driven smooth scrolling to instant; wheel/touch is untouched. */
  function patchScrolling() {
    const toInstant = args => {
      if (args.length === 1 && args[0] && typeof args[0] === 'object' && args[0].behavior === 'smooth') {
        return [{ ...args[0], behavior: 'instant' }];
      }
      return args;
    };

    const nativeScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      return nativeScrollIntoView.apply(this, toInstant(args));
    };

    const nativeScrollTo = window.scrollTo.bind(window);
    window.scrollTo = function (...args) {
      return nativeScrollTo(...toInstant(args));
    };

    const nativeScrollBy = window.scrollBy.bind(window);
    window.scrollBy = function (...args) {
      return nativeScrollBy(...toInstant(args));
    };
  }

  /* ══ SPA navigation tracking ════════════════════════════════════════ */

  /** Tells the content script that the visible conversation changed. */
  function notifyNavigation() {
    window.postMessage(
      { source: MESSAGE_SOURCE, type: 'lumen-navigation', url: location.href },
      location.origin
    );
  }

  const nativePushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    nativePushState(...args);
    notifyNavigation();
  };
  window.addEventListener('popstate', notifyNavigation);

  /* ══ Config bridge (isolated world → here) ══════════════════════════ */

  window.addEventListener('lumen-config', event => {
    const incoming = event && event.detail ? event.detail : null;
    if (!incoming || typeof incoming !== 'object') return;
    settings = sanitize({ ...settings, ...incoming });
    postStatus({ active: Boolean(settings.enabled) });
  });

  window.addEventListener('lumen-request-status', () => {
    postStatus({});
  });

  /* ══ Boot ═══════════════════════════════════════════════════════════ */

  patchScrolling();
  patchFetch();
  postStatus({});
})();
