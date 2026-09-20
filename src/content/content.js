/**
 * Lumen — ChatGPT Speed Booster · isolated content script.
 *
 * Responsibilities:
 *  1. DOM windowing: keep only the active turn window mounted-and-visible.
 *  2. Progressive history: scroll-up reveals mounted turns, then loads
 *     archive chunks (25 msgs) through the main-world worker bridge.
 *  3. Perf style layers, toggled per feature (virtualization / sidebar /
 *     animations) and by the master pause. All performance CSS is dynamic —
 *     the static stylesheet ships only always-safe archive-turn styles.
 *  4. Settings relay between storage / popup and the main-world bridge.
 */

(() => {
  'use strict';

  /* Guard against double injection (manifest + programmatic). */
  if (window.__lumenContentLoaded) return;
  window.__lumenContentLoaded = true;

  /* ══ Constants ══════════════════════════════════════════════════════ */

  /** localStorage key read by the main-world bridge. */
  const CONFIG_KEY = 'lumen_config_v2';

  /* LUMEN-SETTINGS-MODEL-START (keep byte-identical across contexts; tests enforce) */
  const DEFAULTS = Object.freeze({
    enabled: true,
    profile: 'auto',
    customLimit: 10,
    features: Object.freeze({
      instantScroll: true,
      sidebarOptimization: true,
      telemetryBlock: true,
      disableAnimations: true
    })
  });
  const PROFILES = ['auto', 'native', 'fast', 'balanced', 'extreme', 'custom'];
  const CUSTOM_LIMIT_MIN = 2;
  const CUSTOM_LIMIT_MAX = 200;
  const PROFILE_LIMITS = Object.freeze({ fast: 10, balanced: 20, extreme: 5 });
  const AUTO_NATIVE_MAX = 120;
  function clampLimit(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n)
      ? Math.min(CUSTOM_LIMIT_MAX, Math.max(CUSTOM_LIMIT_MIN, n))
      : DEFAULTS.customLimit;
  }
  function sanitizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const f = src.features && typeof src.features === 'object' ? src.features : {};
    return {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
      profile: PROFILES.includes(src.profile) ? src.profile : DEFAULTS.profile,
      customLimit: clampLimit(src.customLimit),
      features: {
        instantScroll: f.instantScroll !== false,
        sidebarOptimization: f.sidebarOptimization !== false,
        telemetryBlock: f.telemetryBlock !== false,
        disableAnimations: f.disableAnimations !== false
      }
    };
  }
  function resolveProfileKeep(profile, customLimit, total) {
    if (profile === 'native') return Infinity;
    if (profile === 'auto') {
      if (total <= AUTO_NATIVE_MAX) return Infinity;
      return Math.min(40, Math.max(20, Math.round(total / 40)));
    }
    if (profile === 'custom') return customLimit;
    return PROFILE_LIMITS[profile] || customLimit;
  }
  /* LUMEN-SETTINGS-MODEL-END */

  /** Safety clamp for the mounted turn window. */
  const KEEP_HARD_CAP = 5000;

  /** Selector for ChatGPT conversation turn elements. */
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';

  /** How many archived messages to reveal / fetch per scroll-up step. */
  const HISTORY_CHUNK = 25;

  /** Scroll position (px from top) that triggers progressive loading. */
  const SCROLL_TRIGGER_PX = 140;

  /** Minimum delay between two progressive-load steps. */
  const LOAD_COOLDOWN_MS = 350;

  /** Minimum delay between two archive fetches. */
  const ARCHIVE_COOLDOWN_MS = 800;

  /** Lifetime cap for injected archive turns. */
  const GHOST_HARD_CAP = 2000;

  /** Class used for injected archive ("ghost") turns. */
  const GHOST_CLASS = 'lumen-ghost';

  /** Core rendering-cost rules — active while Lumen is enabled. */
  const CORE_CSS = `
    article[data-testid^="conversation-turn"] {
      content-visibility: auto;
      contain-intrinsic-size: auto 140px;
      contain: layout style;
    }
    html { scroll-behavior: auto !important; }
  `;

  /** Applied only when the sidebar optimization feature is on. */
  const SIDEBAR_CSS = `
    nav li { content-visibility: auto; contain-intrinsic-size: auto 44px; }
  `;

  /** Applied only when the animation-kill feature is on. */
  const VISUAL_CSS = `
    * {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      transition: none !important;
    }
  `;

  /* ══ State ══════════════════════════════════════════════════════════ */

  let settings = sanitizeSettings(DEFAULTS);

  /** Latest statistics mirrored from the main-world bridge. */
  let lastStatus = {
    layoutSupported: null,
    totalMessages: 0,
    renderedMessages: 0,
    hiddenMessages: 0,
    hasOlderMessages: false,
    active: false
  };

  /** Server-side totals reported with the last fetch-level trim. */
  let fetchTotal = 0;
  let fetchHidden = 0;

  /** Extra DOM turns revealed above the window (scroll-up, same session). */
  let revealedExtra = 0;

  /** rAF coalescing flag for the DOM limiter. */
  let turnLimitQueued = false;

  /** Progressive archive loader state (per conversation). */
  const archive = {
    conversationId: '',
    loading: false,
    exhausted: false,
    injected: 0,
    consumed: 0,
    lastFetch: 0,
    accessToken: null,
    cacheText: null
  };

  /** Suppresses the scroll trigger while Lumen adjusts the viewport. */
  let selfScrollUntil = 0;

  /** Last DOM state applied by the limiter (fast path guard). */
  let appliedDomTotal = -1;
  let appliedHideCount = -1;

  /** Pending archive-extract requests answered by the main-world bridge. */
  let extractReqId = 0;

  /** @type {Map<number, Function>} */
  const extractWaits = new Map();

  /* ══ Generic helpers ════════════════════════════════════════════════ */

  const storageArea = () => chrome.storage.sync || chrome.storage.local;

  /** Clamps `value` into the [min, max] interval. */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Persists the active config for the main-world bridge, syncs the perf
   * style layers, and notifies the bridge.
   */
  function applySettings(next) {
    settings = sanitizeSettings({ ...settings, ...next });
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(settings));
    } catch { /* storage full — bridge keeps its previous config */ }
    window.dispatchEvent(new CustomEvent('lumen-config', { detail: settings }));
    updatePerfStyles();
  }

  /* ══ Perf style layers ══════════════════════════════════════════════ */

  function setStyleElement(id, css) {
    let el = document.getElementById(id);
    if (!css) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.documentElement.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }

  /** Applies the style layers according to the current settings. */
  function updatePerfStyles() {
    const on = settings.enabled;
    const f = settings.features;

    setStyleElement('lumen-perf-core', on ? CORE_CSS : null);
    setStyleElement('lumen-perf-sidebar', on && f.sidebarOptimization ? SIDEBAR_CSS : null);
    setStyleElement('lumen-perf-visual', on && f.disableAnimations ? VISUAL_CSS : null);
  }

  /* ══ DOM windowing (turn limiter) ═══════════════════════════════════ */

  /**
   * Window size for the current conversation state.
   * Delegates to the shared profile model; returns Infinity when no cap
   * should apply (paused, native, or small auto chats).
   */
  function resolveKeep(domTotal) {
    if (!settings.enabled) return Infinity;
    const total = Math.max(fetchTotal, domTotal);
    const keep = resolveProfileKeep(settings.profile, settings.customLimit, total);
    return Number.isFinite(keep) ? Math.min(keep, KEEP_HARD_CAP) : Infinity;
  }

  /**
   * Keeps at most the resolved window of turns mounted-and-visible.
   * Older in-DOM turns are hidden, not removed — React stays consistent.
   * Turns revealed by scroll-up (revealedExtra) stay visible.
   */
  function applyTurnLimit() {
    const turns = document.querySelectorAll(TURN_SELECTOR);
    const domTotal = turns.length;

    if (domTotal === 0) {
      if (lastStatus.totalMessages !== 0 || lastStatus.hiddenMessages !== 0) {
        lastStatus.totalMessages = Math.max(fetchTotal, 0);
        lastStatus.renderedMessages = 0;
        lastStatus.hiddenMessages = fetchHidden;
        lastStatus.hasOlderMessages = fetchHidden > 0;
      }
      return;
    }

    const keep = resolveKeep(domTotal);
    const effectiveKeep = Number.isFinite(keep) ? Math.min(keep + revealedExtra, KEEP_HARD_CAP) : keep;
    const hideCount = Number.isFinite(effectiveKeep) ? Math.max(0, domTotal - effectiveKeep) : 0;

    if (domTotal !== appliedDomTotal || hideCount !== appliedHideCount) {
      for (let i = 0; i < domTotal; i++) {
        const el = turns[i];
        if (i < hideCount) {
          if (el.style.display !== 'none') el.style.display = 'none';
        } else if (el.style.display === 'none') {
          el.style.display = '';
        }
      }
      appliedDomTotal = domTotal;
      appliedHideCount = hideCount;
    }

    const total = Math.max(fetchTotal, domTotal);
    const rendered = domTotal - hideCount + archive.injected;
    const hidden = Math.max(0, total - rendered);

    if (
      hidden !== lastStatus.hiddenMessages ||
      rendered !== lastStatus.renderedMessages ||
      total !== lastStatus.totalMessages
    ) {
      lastStatus.totalMessages = total;
      lastStatus.renderedMessages = rendered;
      lastStatus.hiddenMessages = hidden;
      lastStatus.hasOlderMessages = hidden > 0;
    }
  }

  /** Coalesces limiter runs into one animation frame. */
  function queueTurnLimit() {
    if (turnLimitQueued) return;
    turnLimitQueued = true;
    requestAnimationFrame(() => {
      turnLimitQueued = false;
      applyTurnLimit();
    });
  }

  /** True when the mutation touched a conversation turn element itself —
      streaming text inside an existing turn is deliberately ignored. */
  function isTurnMutation(records) {
    return records.some(record =>
      [...record.addedNodes].some(isTurnNode) ||
      [...record.removedNodes].some(isTurnNode)
    );
  }

  function isTurnNode(node) {
    if (!node || node.nodeType !== 1) return false;
    return (
      (node.matches && node.matches('[data-testid^="conversation-turn-"]')) ||
      (node.querySelector && Boolean(node.querySelector('[data-testid^="conversation-turn-"]')))
    );
  }

  /** Observes DOM changes so the window holds during streaming/navigation. */
  function setupTurnLimiter() {
    new MutationObserver(records => {
      if (isTurnMutation(records)) queueTurnLimit();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    /* Safety net for missed mutations (e.g. bfcache restores). */
    setInterval(queueTurnLimit, 2500);
    queueTurnLimit();
  }

  /* ══ Progressive history: archive turns ═════════════════════════════ */

  /**
   * Extracts the conversation UUID from a chat URL, if present.
   * @returns {string} UUID or an empty string
   */
  function getConversationId() {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return match ? match[1] : '';
  }

  /**
   * Fetches (and caches) the web session access token.
   * @returns {Promise<string|null>}
   */
  async function getAccessToken() {
    if (archive.accessToken) return archive.accessToken;
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      const data = await response.json();
      archive.accessToken = data && data.accessToken ? data.accessToken : null;
    } catch {
      archive.accessToken = null;
    }
    return archive.accessToken;
  }

  /**
   * Requests an archive slice from the main-world worker bridge.
   * The raw conversation JSON never touches the page's main thread JS.
   */
  function requestExtract(text, skip, count) {
    return new Promise(resolve => {
      const reqId = ++extractReqId;
      extractWaits.set(reqId, resolve);
      window.dispatchEvent(new CustomEvent('lumen-extract-request', {
        detail: { reqId, text, skip, count }
      }));
      setTimeout(() => {
        if (extractWaits.delete(reqId)) resolve(null);
      }, 6500);
    });
  }

  /* ══ Rich (markdown-ish) ghost rendering — DOM-API only ═════════════ */

  /* Message text is NEVER treated as HTML: every text fragment lands in a
     text node, elements are created with createElement, links go through
     URL validation (http/https only) and receive fixed attributes. */

  /** Tokenizer for inline markdown: code, bold, italic, links. */
  const INLINE_TOKEN = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;

  /**
   * Builds a link element for [label](url); non-http(s) or malformed URLs
   * render as inert text (no href attribute at all).
   */
  function createSafeLink(doc, label, rawUrl) {
    const a = doc.createElement('a');
    a.textContent = label;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        a.setAttribute('href', parsed.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    } catch { /* not a URL — stays inert text */ }
    return a;
  }

  /**
   * Appends the inline-markdown rendering of `text` to `parent` using
   * createElement/createTextNode exclusively.
   */
  function appendInlineMarkdown(doc, parent, text) {
    const re = new RegExp(INLINE_TOKEN.source, 'g');
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        parent.appendChild(doc.createTextNode(text.slice(last, match.index)));
      }
      if (match[2] !== undefined) {
        const code = doc.createElement('code');
        code.textContent = match[2];
        parent.appendChild(code);
      } else if (match[4] !== undefined) {
        const strong = doc.createElement('strong');
        strong.textContent = match[4];
        parent.appendChild(strong);
      } else if (match[6] !== undefined) {
        const em = doc.createElement('em');
        em.textContent = match[6];
        parent.appendChild(em);
      } else if (match[8] !== undefined) {
        parent.appendChild(createSafeLink(doc, match[8], match[9]));
      }
      last = re.lastIndex;
    }
    if (last < text.length) {
      parent.appendChild(doc.createTextNode(text.slice(last)));
    }
  }

  /**
   * Renders markdown-ish text into `root` with DOM APIs only. Supported:
   * paragraphs, fenced code, inline code, bold, italic, simple lists and
   * safe http/https links. Nothing is ever parsed as HTML.
   * @param {Element} root  container to fill
   * @param {string} text   raw message text
   * @param {Document} [doc] document factory (tests inject a fake)
   */
  function renderRichInto(root, text, doc) {
    const d = doc || document;
    String(text).split('```').forEach((part, idx) => {
      if (idx % 2 === 1) {
        /* fenced code block; first line may carry the language tag */
        const nl = part.indexOf('\n');
        const code = (nl === -1 ? '' : part.slice(nl + 1)).replace(/\n$/, '');
        const pre = d.createElement('pre');
        const codeEl = d.createElement('code');
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        root.appendChild(pre);
        return;
      }
      part.split(/\n{2,}/).forEach(block => {
        const lines = block.split('\n').filter(l => l.trim().length);
        if (lines.length === 0) return;
        if (lines.every(l => /^\s*[-*] /.test(l))) {
          const ul = d.createElement('ul');
          lines.forEach(l => {
            const li = d.createElement('li');
            appendInlineMarkdown(d, li, l.replace(/^\s*[-*] /, ''));
            ul.appendChild(li);
          });
          root.appendChild(ul);
        } else {
          const p = d.createElement('p');
          lines.forEach((l, i) => {
            if (i > 0) p.appendChild(d.createElement('br'));
            appendInlineMarkdown(d, p, l);
          });
          root.appendChild(p);
        }
      });
    });
  }

  /**
   * Builds a read-only archive turn: role label + rich (markdown-ish) body,
   * rendered from DOM text nodes only.
   */
  function buildGhostTurn(item) {
    const wrap = document.createElement('div');
    wrap.className = GHOST_CLASS;
    wrap.setAttribute('data-lumen', 'ghost');

    const role = document.createElement('div');
    role.className = 'lumen-ghost-role';
    role.textContent = item.role === 'user' ? 'You' : 'ChatGPT';

    const body = document.createElement('div');
    body.className = 'lumen-ghost-body';
    renderRichInto(body, item.text);

    wrap.append(role, body);
    return wrap;
  }

  /**
   * Fetches one chunk of older messages and mounts it above the thread,
   * keeping the viewport anchored to the same content.
   */
  async function loadOlderChunk() {
    const conversationId = getConversationId();
    if (!conversationId) return;

    if (archive.conversationId !== conversationId) {
      archive.conversationId = conversationId;
      archive.exhausted = false;
      archive.loading = false;
      archive.injected = 0;
      archive.consumed = 0;
      archive.cacheText = null;
    }
    if (archive.exhausted || archive.loading) return;

    const now = Date.now();
    if (now - archive.lastFetch < ARCHIVE_COOLDOWN_MS) return;

    /* skip = messages already visible at load + messages consumed so far.
       Counting consumed turns (not text items) keeps the pagination gap-free
       even when some turns carry no renderable text. */
    const visibleBase = Math.max(0, fetchTotal - fetchHidden);
    const skip = visibleBase + archive.consumed;
    if (skip <= 0 || archive.injected >= GHOST_HARD_CAP) {
      archive.exhausted = true;
      return;
    }

    archive.loading = true;
    archive.lastFetch = now;

    try {
      /* the conversation downloads only once per chat, then it is cached */
      if (!archive.cacheText) {
        const token = await getAccessToken();
        if (!token) return;

        const response = await fetch(`/backend-api/conversation/${conversationId}`, {
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` }
        });
        if (response.status === 401) {
          archive.accessToken = null;
          return;
        }
        if (!response.ok) return;
        archive.cacheText = await response.text();
      }

      const result = await requestExtract(archive.cacheText, skip, HISTORY_CHUNK);
      if (!result) return;

      /* Exhaustion means the traversal made no progress. A chunk full of
         non-text turns still advanced (consumedCount > 0) — pagination
         must continue, only the rendered ghosts are zero. */
      if (!result.consumedCount) {
        archive.exhausted = true;
        return;
      }
      archive.consumed += result.consumedCount;

      const firstTurn = document.querySelector(TURN_SELECTOR);
      const container = firstTurn && firstTurn.parentElement;
      if (!container) return;

      const heightBefore = document.documentElement.scrollHeight;
      const fragment = document.createDocumentFragment();
      result.items.forEach(item => fragment.appendChild(buildGhostTurn(item)));
      container.insertBefore(fragment, container.firstChild);
      archive.injected += result.items.length;

      /* Keep the viewport anchored — never fight a bottom-anchored view. */
      const delta = document.documentElement.scrollHeight - heightBefore;
      const distanceToBottom =
        document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      if (delta > 0 && distanceToBottom > 240) {
        selfScrollUntil = Date.now() + 150;
        window.scrollBy(0, delta);
      }

      if (result.reachedStart || archive.injected >= GHOST_HARD_CAP) {
        archive.exhausted = true;
      }
    } catch {
      /* Network hiccups are silently ignored — the next scroll retries. */
    } finally {
      archive.loading = false;
    }
  }

  /**
   * Progressive loader, invoked when the user scrolls near the top:
   * first reveal DOM turns hidden by the window, then fetch archive chunks.
   */
  async function maybeLoadOlder() {
    if (!settings.enabled || archive.exhausted || archive.loading) return;
    if (!lastStatus.hasOlderMessages) return;
    if (window.scrollY > SCROLL_TRIGGER_PX) return;
    if (Date.now() < selfScrollUntil) return;

    /* Step 1 — reveal DOM turns hidden by the window (instant, free). */
    const domTotal = document.querySelectorAll(TURN_SELECTOR).length;
    const keep = resolveKeep(domTotal);
    const domHidden = Number.isFinite(keep) ? Math.max(0, domTotal - keep - revealedExtra) : 0;
    if (domHidden > 0) {
      revealedExtra += Math.min(HISTORY_CHUNK, domHidden);
      queueTurnLimit();
      return;
    }

    /* Step 2 — fetch archive messages that were never loaded. */
    await loadOlderChunk();
  }

  /** Wires the throttled scroll trigger for progressive history. */
  function setupScrollLoader() {
    let lastRun = 0;
    window.addEventListener('scroll', () => {
      const now = Date.now();
      if (now - lastRun < LOAD_COOLDOWN_MS) return;
      lastRun = now;
      maybeLoadOlder();
    }, { passive: true });
  }

  /** Resets per-conversation state and removes archive turns. */
  function resetConversationState() {
    revealedExtra = 0;
    fetchTotal = 0;
    fetchHidden = 0;
    archive.loading = false;
    archive.exhausted = false;
    archive.injected = 0;
    archive.consumed = 0;
    archive.lastFetch = 0;
    archive.conversationId = '';
    archive.cacheText = null;
    appliedDomTotal = -1;
    appliedHideCount = -1;
    queueTurnLimit();
  }

  /* ══ Window bridge (main world → here) ══════════════════════════════ */

  function setupWindowBridge() {
    window.addEventListener('message', event => {
      if (event.source !== window || !event.data || event.data.source !== 'lumen_main') return;

      if (event.data.type === 'lumen-status' && event.data.payload) {
        lastStatus = { ...lastStatus, ...event.data.payload };
        fetchTotal = Number(event.data.payload.totalMessages) || 0;
        fetchHidden = Number(event.data.payload.hiddenMessages) || 0;
        queueTurnLimit();
      }

      if (event.data.type === 'lumen-extract-response') {
        const waiter = extractWaits.get(event.data.reqId);
        if (waiter) {
          extractWaits.delete(event.data.reqId);
          waiter({
            items: event.data.items || [],
            consumedCount: Number(event.data.consumedCount) || 0,
            reachedStart: !!event.data.reachedStart
          });
        }
      }

      if (event.data.type === 'lumen-navigation') {
        resetConversationState();
      }
    });
  }

  /* ══ Chrome messaging (popup / service worker → here) ═══════════════ */

  function setupMessages() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return;

      switch (message.type) {
        case 'settingsUpdated':
          applySettings(message.payload || {});
          queueTurnLimit();
          sendResponse({ ok: true });
          break;

        case 'trimNow':
          storageArea().get(DEFAULTS).then(fresh => {
            applySettings(fresh);
            location.reload();
          });
          sendResponse({ ok: true });
          return true;

        case 'getStatus':
          sendResponse({
            ok: true,
            layoutSupported: lastStatus.layoutSupported,
            enabled: settings.enabled,
            profile: settings.profile,
            totalMessages: lastStatus.totalMessages,
            renderedMessages: lastStatus.renderedMessages,
            hiddenMessages: lastStatus.hiddenMessages,
            hasOlderMessages: lastStatus.hasOlderMessages,
            processing: false
          });
          break;
      }
    });
  }

  /* ══ Init ═══════════════════════════════════════════════════════════ */

  async function init() {
    try {
      const raw = await storageArea().get(DEFAULTS);
      applySettings(raw);
      setupWindowBridge();
      setupMessages();
      setupTurnLimiter();
      setupScrollLoader();
      window.dispatchEvent(new Event('lumen-request-status'));
    } catch {
      /* Never let init failures surface on the page. */
    }
  }

  init();

  /* ══ Test hooks (never active in the browser) ═══════════════════════ */

  if (globalThis.__LUMEN_EXPOSE_TEST_HOOKS__) {
    globalThis.__LUMEN_TEST_CONTENT__ = {
      DEFAULTS, PROFILES, PROFILE_LIMITS,
      sanitizeSettings, resolveProfileKeep, renderRichInto,
      HISTORY_CHUNK, GHOST_HARD_CAP, TURN_SELECTOR, GHOST_CLASS
    };
  }
})();
