/**
 * Lumen — ChatGPT Speed Booster · popup controller.
 *
 * Controls: master performance toggle (with page reload so an already
 * trimmed conversation is refetched pristine), performance profile,
 * custom message limit, four feature toggles, optimize/reload actions.
 * All texts come from chrome.i18n.
 */

(() => {
  'use strict';

  /* ══ Constants ══════════════════════════════════════════════════════ */

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
    const display = document.getElementById('limitDisplay');
    display.value = String(customLimit);
    display.max = String(CUSTOM_LIMIT_MAX);
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
    let settings = sanitizeSettings(await store.get(DEFAULTS));
    renderStatusChip(settings);
    renderCustomLimit(settings.customLimit);
    renderStats(await sendToTab(tabId, { type: 'getStatus' }));

    /* Master performance toggle. Pausing stops every modification from now
       on, but a conversation already trimmed in memory cannot be un-trimmed
       — so the page reloads and ChatGPT refetches its pristine payload.
       Reloading in both directions keeps the state unambiguous and cannot
       loop: it only happens from this explicit user action. */
    const toggle = document.getElementById('enabled');
    toggle.checked = settings.enabled;
    toggle.addEventListener('change', async event => {
      settings = sanitizeSettings({ ...settings, enabled: event.target.checked });
      await store.set(settings);
      renderStatusChip(settings);
      if (tabId) await chrome.tabs.reload(tabId);
      window.close();
    });

    /* Performance profile */
    const profileSelect = document.getElementById('profile');
    profileSelect.value = settings.profile;
    profileSelect.addEventListener('change', async event => {
      settings = sanitizeSettings({ ...settings, profile: event.target.value });
      await store.set(settings);
      await commitSettings(settings, tabId);
    });

    /* Custom message limit stepper */
    document.getElementById('limitDec').addEventListener('click', async () => {
      settings = sanitizeSettings({ ...settings, customLimit: clampLimit(settings.customLimit - 1) });
      renderCustomLimit(settings.customLimit);
      await commitSettings(settings, tabId);
    });

    document.getElementById('limitInc').addEventListener('click', async () => {
      settings = sanitizeSettings({ ...settings, customLimit: clampLimit(settings.customLimit + 1) });
      renderCustomLimit(settings.customLimit);
      await commitSettings(settings, tabId);
    });

    const limitInput = document.getElementById('limitDisplay');
    limitInput.addEventListener('blur', async event => {
      const next = clampLimit(event.target.value);
      if (next !== settings.customLimit) {
        settings = sanitizeSettings({ ...settings, customLimit: next });
        await commitSettings(settings, tabId);
      }
      renderCustomLimit(settings.customLimit);
    });
    limitInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') event.target.blur();
    });

    /* Feature toggles — each drives one reversible runtime effect */
    const featureBindings = [
      ['instantScroll', 'instantScroll'],
      ['sidebarOptimization', 'sidebarOptimization'],
      ['disableAnimations', 'disableAnimations'],
      ['telemetryBlock', 'telemetryBlock']
    ];
    featureBindings.forEach(([id, key]) => {
      const box = document.getElementById(id);
      box.checked = settings.features[key];
      box.addEventListener('change', async event => {
        settings.features[key] = event.target.checked;
        await store.set(settings);
      });
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

  /* ══ Test hooks (never active in the browser) ═══════════════════════ */

  if (globalThis.__LUMEN_EXPOSE_TEST_HOOKS__) {
    globalThis.__LUMEN_TEST_POPUP__ = {
      DEFAULTS, PROFILES, PROFILE_LIMITS, sanitizeSettings, resolveProfileKeep
    };
  }
})();
