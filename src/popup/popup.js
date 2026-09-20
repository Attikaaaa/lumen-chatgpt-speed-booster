/**
 * Lumen — ChatGPT Speed Booster · popup controller.
 *
 * Reads the active tab, renders live statistics from the content script and
 * wires the controls: master performance toggle, performance profile
 * (auto/fast/balanced/extreme/native/custom), custom message limit,
 * optimize/reload actions. All texts come from chrome.i18n.
 */

(() => {
  'use strict';

  /* ══ Constants ══════════════════════════════════════════════════════ */

  /** Default user settings — mirrored by the service worker. */
  const DEFAULTS = Object.freeze({
    enabled: true,
    profile: 'auto',
    customLimit: 10
  });

  /** Bounds for the custom message limit. */
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
   * @returns {{enabled: boolean, profile: string, customLimit: number}}
   */
  function sanitize(raw) {
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      profile: typeof raw.profile === 'string' && PROFILES.includes(raw.profile)
        ? raw.profile
        : DEFAULTS.profile,
      customLimit: clamp(Number(raw.customLimit) || DEFAULTS.customLimit, LIMIT_MIN, LIMIT_MAX)
    };
  }

  const PROFILES = ['auto', 'native', 'fast', 'balanced', 'extreme', 'custom'];

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
   * @param {object | null} status
   */
  function renderStats(status) {
    const rendered = Number(status && status.renderedMessages) || 0;
    const total = Number(status && status.totalMessages) || 0;
    const hidden = Math.max(0, total - rendered);
    const hasData = total > 0;

    document.getElementById('renderedCount').textContent = hasData ? String(rendered) : '—';
    document.getElementById('totalCount').textContent = hasData ? String(total) : '—';
    document.getElementById('memorySaved').textContent =
      hasData ? `${Math.round((hidden / total) * 100)}%` : '—';

    const visiblePct = hasData ? Math.round((rendered / total) * 100) : 0;
    document.getElementById('progressFill').style.width = hasData ? `${visiblePct}%` : '0%';
  }

  /** Syncs the custom-limit stepper with the stored value. */
  function renderCustomLimit(customLimit) {
    const display = document.getElementById('customLimit');
    display.value = String(customLimit);
    display.max = String(LIMIT_MAX);
  }

  /**
   * Persists settings, then refreshes chip + stats from the page.
   * @param {object} settings
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
    renderCustomLimit(settings.customLimit);
    renderStats(await sendToTab(tabId, { type: 'getStatus' }));

    /* Master performance toggle */
    const toggle = document.getElementById('enabled');
    toggle.checked = settings.enabled;
    toggle.addEventListener('change', async event => {
      settings = sanitize({ ...settings, enabled: event.target.checked });
      await store.set(settings);
      renderStatusChip(settings);
      renderStats(await sendToTab(tabId, { type: 'getStatus' }));
    });

    /* Performance profile */
    const profileSelect = document.getElementById('profile');
    profileSelect.value = settings.profile;
    profileSelect.addEventListener('change', async event => {
      settings = sanitize({ ...settings, profile: event.target.value });
      await store.set(settings);
      await commitSettings(settings, tabId);
    });

    /* Custom message limit stepper */
    document.getElementById('limitDec').addEventListener('click', async () => {
      settings = sanitize({ ...settings, customLimit: clamp(settings.customLimit - 1, LIMIT_MIN, LIMIT_MAX) });
      renderCustomLimit(settings.customLimit);
      await store.set(settings);
      await commitSettings(settings, tabId);
    });

    document.getElementById('limitInc').addEventListener('click', async () => {
      settings = sanitize({ ...settings, customLimit: clamp(settings.customLimit + 1, LIMIT_MIN, LIMIT_MAX) });
      renderCustomLimit(settings.customLimit);
      await store.set(settings);
      await commitSettings(settings, tabId);
    });

    const limitInput = document.getElementById('limitDisplay');
    limitInput.addEventListener('blur', async event => {
      const next = clamp(Number(event.target.value) || settings.customLimit, LIMIT_MIN, LIMIT_MAX);
      if (next !== settings.customLimit) {
        settings = sanitize({ ...settings, customLimit: next });
        await store.set(settings);
        await commitSettings(settings, tabId);
      }
      renderCustomLimit(settings.customLimit);
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
