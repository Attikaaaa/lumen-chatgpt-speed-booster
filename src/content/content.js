/**
 * Lumen — ChatGPT Speed Booster · isolated content script.
 * Caps mounted conversation turns, loads older messages on scroll-up
 * (reveal + on-demand archive), and relays settings/stats. No visible UI.
 */

(() => {
  'use strict';

  /* Guard against double injection (manifest + programmatic). */
  if (window.__lumenContentLoaded) return;
  window.__lumenContentLoaded = true;

  /* ══ Constants ══════════════════════════════════════════════════════ */

  /** localStorage key read by the main-world bridge. */
  const CONFIG_KEY = 'lumen_config_v1';

  /** Default user settings — mirrored by the service worker. */
  const DEFAULTS = Object.freeze({ enabled: true, limit: 10 });

  /** Safety clamp shared with the main-world bridge. */
  const KEEP_HARD_CAP = 5000;

  /** Selector for ChatGPT conversation turn elements. */
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';

  /** How many archived messages to reveal / fetch per scroll-up step. */
  const HISTORY_CHUNK = 25;

  /** Safety cap on total archived messages injected in one conversation. */
  const GHOST_HARD_CAP = 2000;

  /** Minimum delay between two archive fetches. */
  const ARCHIVE_COOLDOWN_MS = 800;

  /** Scroll position (px from top) that triggers progressive loading. */
  const SCROLL_TRIGGER_PX = 140;

  /** Minimum delay between two progressive-load steps. */
  const LOAD_COOLDOWN_MS = 350;

  /** Class used for injected archive ("ghost") turns. */
  const GHOST_CLASS = 'lumen-ghost';

  /* ══ State ══════════════════════════════════════════════════════════ */

  let settings = { ...DEFAULTS };

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

  /** Extra DOM turns revealed above the configured limit (scroll-up). */
  let revealedExtra = 0;

  /** rAF coalescing flag for the DOM limiter. */
  let turnLimitQueued = false;

  /** Last DOM state the limiter applied — enables a zero-work fast path
      while a response is streaming (count unchanged → skip the loop). */
  let appliedDomTotal = -1;
  let appliedHideCount = -1;

  /** Progressive archive loader state (per conversation). */
  const archive = {
    conversationId: '',
    loading: false,
    exhausted: false,
    injected: 0,
    lastFetch: 0,
    accessToken: null
  };

  /** Suppresses the scroll trigger while Lumen itself adjusts the viewport. */
  let selfScrollUntil = 0;

  /* ══ Generic helpers ════════════════════════════════════════════════ */

  const storageArea = () => chrome.storage.sync || chrome.storage.local;

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

  /**
   * Persists the active config for the main-world bridge and notifies it.
   * @param {{enabled: boolean, limit: number}} next
   */
  function applySettings(next) {
    settings = sanitize({ ...settings, ...next });
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(settings));
    } catch { /* storage full — bridge keeps its previous config */ }
    window.dispatchEvent(new CustomEvent('lumen-config', { detail: settings }));
  }

  /* ══ DOM limiter ════════════════════════════════════════════════════ */

  /**
   * Keeps at most (limit + revealedExtra) turns mounted and visible.
   * Older in-DOM turns are hidden, not removed — React stays consistent.
   */
  function applyTurnLimit() {
    const turns = document.querySelectorAll(TURN_SELECTOR);
    const domTotal = turns.length;

    if (domTotal === 0) {
      appliedDomTotal = 0;
      appliedHideCount = 0;
      if (lastStatus.totalMessages !== 0 || lastStatus.hiddenMessages !== 0) {
        lastStatus.totalMessages = Math.max(fetchTotal, 0);
        lastStatus.renderedMessages = 0;
        lastStatus.hiddenMessages = fetchHidden;
        lastStatus.hasOlderMessages = fetchHidden > 0;
      }
      return;
    }

    const keep = settings.enabled
      ? clamp(settings.limit + revealedExtra, 1, KEEP_HARD_CAP)
      : KEEP_HARD_CAP;
    const hideCount = Math.max(0, domTotal - keep);

    /* Fast path: while a response streams in, the turn count only changes
       when a turn is added — per-token frames skip the DOM pass entirely. */
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
    const rendered = domTotal - hideCount;
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

  /** Observes DOM changes so the cap holds during streaming and navigation. */
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

  /* ══ Progressive history: ghost turns ═══════════════════════════════ */

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
   * Extracts a chronological slice of visible messages from a conversation
   * payload, counting from the END (newest) backwards.
   *
   * @param {*} payload   parsed /backend-api/conversation/:id response
   * @param {number} skip how many newest messages to skip
   * @param {number} count how many messages to return
   * @returns {{items: Array<{role: string, text: string}>, reachedStart: boolean}}
   */
  function extractMessageSlice(payload, skip, count) {
    if (!payload || typeof payload !== 'object' || !payload.mapping || !payload.current_node) {
      return { items: [], reachedStart: true };
    }

    const mapping = payload.mapping;
    const guard = new Set();
    const path = [];
    let id = payload.current_node;
    while (id && mapping[id] && !guard.has(id)) {
      guard.add(id);
      path.unshift(id);
      id = mapping[id].parent;
    }

    const bubbles = path
      .map(nodeId => mapping[nodeId])
      .filter(node => {
        const role = node && node.message && node.message.author && node.message.author.role;
        return role === 'user' || role === 'assistant';
      });

    const end = Math.max(0, bubbles.length - skip);
    const start = Math.max(0, end - count);

    const items = [];
    for (let i = start; i < end; i++) {
      const message = bubbles[i].message;
      const parts = (message.content && Array.isArray(message.content.parts))
        ? message.content.parts
        : [];
      const text = parts.filter(part => typeof part === 'string').join('\n').trim();
      if (text) items.push({ role: message.author.role, text });
    }

    return { items, reachedStart: start === 0 };
  }

  /**
   * Builds a read-only archive turn. Text-only by design: archived messages
   * are never re-rendered as live chat bubbles, so formatting is simplified.
   *
   * @param {{role: string, text: string}} item
   * @returns {HTMLElement}
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
    body.textContent = item.text;

    wrap.append(role, body);
    return wrap;
  }

  /**
   * Fetches one chunk of older messages and mounts it above the thread,
   * keeping the viewport anchored to the same content.
   * @returns {Promise<void>}
   */
  async function loadOlderChunk() {
    const conversationId = getConversationId();
    if (!conversationId) return;

    if (archive.conversationId !== conversationId) {
      archive.conversationId = conversationId;
      archive.exhausted = false;
      archive.loading = false;
      archive.injected = 0;
    }
    if (archive.exhausted || archive.loading) return;

    const now = Date.now();
    if (now - archive.lastFetch < ARCHIVE_COOLDOWN_MS) return;

    /* Messages already accounted for: rendered at load + ghosts injected.
       This MUST shrink as chunks are consumed, otherwise the same slice
       would be fetched forever. */
    const skip = Math.max(0, fetchHidden - archive.injected);
    if (skip <= 0 || archive.injected >= GHOST_HARD_CAP) {
      archive.exhausted = true;
      return;
    }

    archive.loading = true;
    archive.lastFetch = now;

    try {
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

      const payload = await response.json();
      const { items, reachedStart } = extractMessageSlice(payload, skip, HISTORY_CHUNK);

      if (items.length === 0) {
        archive.exhausted = true;
        return;
      }

      const firstTurn = document.querySelector(TURN_SELECTOR);
      const container = firstTurn && firstTurn.parentElement;
      if (!container) return;

      const heightBefore = document.documentElement.scrollHeight;
      const fragment = document.createDocumentFragment();
      items.forEach(item => fragment.appendChild(buildGhostTurn(item)));
      container.insertBefore(fragment, container.firstChild);
      archive.injected += items.length;

      /* Keep the viewport anchored — but never fight a bottom-anchored view
         (adding content above cannot move a bottom-anchored reader). */
      const delta = document.documentElement.scrollHeight - heightBefore;
      const distanceToBottom =
        document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      if (delta > 0 && distanceToBottom > 240) {
        selfScrollUntil = Date.now() + 150; /* ignore our own scroll event */
        window.scrollBy(0, delta);
      }

      if (reachedStart || items.length < HISTORY_CHUNK || archive.injected >= GHOST_HARD_CAP) {
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
   *   1. reveal DOM turns hidden by the in-session limiter (instant, free),
   *   2. otherwise fetch one archive chunk from the server.
   * @returns {Promise<void>}
   */
  async function maybeLoadOlder() {
    if (!settings.enabled || archive.exhausted || archive.loading) return;
    if (!lastStatus.hasOlderMessages) return;
    if (window.scrollY > SCROLL_TRIGGER_PX) return;
    if (Date.now() < selfScrollUntil) return;

    /* Step 1 — reveal turns that are already mounted. */
    const domTotal = document.querySelectorAll(TURN_SELECTOR).length;
    const keep = clamp(settings.limit + revealedExtra, 1, KEEP_HARD_CAP);
    const domHidden = Math.max(0, domTotal - keep);
    if (domHidden > 0) {
      revealedExtra += domHidden;
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
    archive.lastFetch = 0;
    archive.conversationId = '';
    appliedDomTotal = -1;
    appliedHideCount = -1;
    document.querySelectorAll(`.${GHOST_CLASS}`).forEach(node => node.remove());
    lastStatus = {
      layoutSupported: null,
      totalMessages: 0,
      renderedMessages: 0,
      hiddenMessages: 0,
      hasOlderMessages: false,
      active: Boolean(settings.enabled)
    };
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
            limit: settings.limit,
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
})();
