/**
 * Lumen — ChatGPT Speed Booster
 * -----------------------------
 * Popup controller.
 *
 * Reads the active tab, renders live statistics from the content script and
 * wires the controls: booster toggle, message cap, optimize-now and reload.
 * All texts come from chrome.i18n (English / Hungarian locales).
 */

(() => {
  'use strict';

  /* ══ Constants ══════════════════════════════════════════════════════ */

  /** Default user settings — must mirror the service worker. */
  const DEFAULTS = Object.freeze({ enabled: true, limit: 10 });

  /** Bounds for the message-cap stepper. */
  const LIMIT_MIN = 2;
  const LIMIT_MAX = 200;

  /** Settings storage. */
  const store = chrome.storage.sync || chrome.storage.local;

  /* ══ Helpers ════════════════════════════════════════════════════════ */

  /**
   * Resolves a localized message with optional substitutions.
   * @param {string} key
   * @param {string[]} [subs]
   * @returns {string}
   */
  function t(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
  }

  /** Clamps `value` into the [min, max] interval. */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Type-checks a raw settings object coming from storage.
   * @param {*} raw
   * @returns {{enabled: boolean, limit: number}}
   */
  function sanitize(raw) {
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      limit: clamp(Number(raw.limit) || DEFAULTS.limit, LIMIT_MIN, LIMIT_MAX)
    };
  }

  /**
   * True when the URL belongs to a supported ChatGPT host.
   * @param {string} [url]
   * @returns {boolean}
   */
  function isSupportedUrl(url) {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' &&
        (parsed.hostname === 'chatgpt.com' || parsed.hostname === 'chat.openai.com');
    } catch {
      return false;
    }
  }

  /**
   * Returns the active tab of the current window.
   * @returns {Promise<chrome.tabs.Tab | null>}
   */
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  /**
   * Sends a message to the content script with a short timeout guard.
   * @param {number | null} tabId
   * @param {object} message
   * @returns {Promise<object | null>}
   */
  async function sendToTab(tabId, message) {
    if (!tabId) return null;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, message),
        new Promise(resolve => setTimeout(() => resolve(null), 900))
      ]);
    } catch {
      return null;
    }
  }

  /* ══ Renderers ══════════════════════════════════════════════════════ */

  /** Localizes every element carrying a data-i18n attribute. */
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.getElementById('reloadPage').title = t('reloadPage');
  }

  /**
   * Reflects the enabled state on the status chip.
   * @param {{enabled: boolean}} settings
   */
  function renderStatusChip(settings) {
    document.getElementById('statusChip').classList.toggle('is-paused', !settings.enabled);
    document.getElementById('statusText').textContent =
      t(settings.enabled ? 'statusActive' : 'statusPaused');
  }

  /**
   * Renders live conversation statistics reported by the content script.
   * Hero = percentage of the conversation kept out of view; the gauge dot
   * marks the "in view" position along the full thread.
   * @param {object | null} status
   */
  function renderStats(status) {
    const rendered = Number(status && status.renderedMessages) || 0;
    const total = Number(status && status.totalMessages) || 0;
    const hidden = Math.max(0, total - rendered);
    const hasData = total > 0;
    const savedPct = hasData ? Math.round((hidden / total) * 100) : 0;

    document.getElementById('memorySaved').textContent = hasData ? `${savedPct}%` : '—';
    document.getElementById('subLine').textContent = hasData
      ? `${rendered} ${t('renderedLabel').toLowerCase()} · ${total} ${t('totalLabel').toLowerCase()}`
      : '—';
    document.getElementById('gaugeDot').style.left =
      hasData ? `${Math.round((rendered / total) * 100)}%` : '0%';
  }

  /** Syncs the stepper input with the current limit. */
  function renderLimit(limit) {
    const display = document.getElementById('limitDisplay');
    display.value = String(limit);
    display.max = String(LIMIT_MAX);
  }

  /**
   * Persists settings, then refreshes chip + stats from the page.
   * @param {{enabled: boolean, limit: number}} settings
   * @param {number | null} tabId
   */
  async function commitSettings(settings, tabId) {
    await store.set(settings);
    renderStatusChip(settings);
    renderStats(await sendToTab(tabId, { type: 'getStatus' }));
  }

  /* ══ View wiring ════════════════════════════════════════════════════ */

  /**
   * Attaches all control handlers for the main (ChatGPT) view.
   * @param {number | null} tabId
   */
  async function setupMainView(tabId) {
    let settings = sanitize(await store.get(DEFAULTS));
    renderStatusChip(settings);
    renderLimit(settings.limit);
    renderStats(await sendToTab(tabId, { type: 'getStatus' }));

    /* Booster toggle */
    const toggle = document.getElementById('enabled');
    toggle.checked = settings.enabled;
    toggle.addEventListener('change', async event => {
      settings = sanitize({ ...settings, enabled: event.target.checked });
      await commitSettings(settings, tabId);
    });

    /* Message cap stepper */
    document.getElementById('limitDec').addEventListener('click', async () => {
      settings = sanitize({ ...settings, limit: clamp(settings.limit - 1, LIMIT_MIN, LIMIT_MAX) });
      renderLimit(settings.limit);
      await commitSettings(settings, tabId);
    });

    document.getElementById('limitInc').addEventListener('click', async () => {
      settings = sanitize({ ...settings, limit: clamp(settings.limit + 1, LIMIT_MIN, LIMIT_MAX) });
      renderLimit(settings.limit);
      await commitSettings(settings, tabId);
    });

    const limitInput = document.getElementById('limitDisplay');
    limitInput.addEventListener('blur', async event => {
      const next = clamp(Number(event.target.value) || settings.limit, LIMIT_MIN, LIMIT_MAX);
      if (next !== settings.limit) {
        settings = sanitize({ ...settings, limit: next });
        await commitSettings(settings, tabId);
      }
      renderLimit(settings.limit);
    });
    limitInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') event.target.blur();
    });

    /* Optimize now — persist, give the page a beat, then re-trim via reload */
    document.getElementById('optimizeNow').addEventListener('click', async () => {
      await store.set(settings);
      await new Promise(resolve => setTimeout(resolve, 250));
      sendToTab(tabId, { type: 'trimNow' });
      window.close();
    });

    /* Plain page reload */
    document.getElementById('reloadPage').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      if (tabId) await chrome.tabs.reload(tabId);
      window.close();
    });
  }

  /* ══ Init ═══════════════════════════════════════════════════════════ */

  async function init() {
    applyI18n();

    const tab = await getActiveTab();
    const tabId = tab ? tab.id : null;

    if (!tab || !isSupportedUrl(tab.url)) {
      document.getElementById('mainView').classList.add('hidden');
      document.getElementById('blockedView').classList.remove('hidden');
      return;
    }

    await setupMainView(tabId);
  }

  init();
})();
