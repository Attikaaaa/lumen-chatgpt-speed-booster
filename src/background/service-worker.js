/**
 * Lumen — ChatGPT Speed Booster · background service worker.
 * Seeds default settings, broadcasts changes to open ChatGPT tabs, and
 * toggles the telemetry blocklist together with the privacy feature.
 */

(() => {
  'use strict';

  /* ══ Constants ══════════════════════════════════════════════════════ */

  /** Default user settings — mirrored by the popup and the content script. */
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

  /** Hostnames Lumen operates on. */
  const SUPPORTED_HOSTS = ['chatgpt.com', 'chat.openai.com'];

  /** Settings storage (sync keeps preferences across devices). */
  const store = chrome.storage.sync || chrome.storage.local;

  const RULESET_ID = 'network_rules';

  /* ══ Helpers ════════════════════════════════════════════════════════ */

  /**
   * Returns true when the URL belongs to a supported ChatGPT host.
   * @param {string} [url]
   * @returns {boolean}
   */
  function isSupportedUrl(url) {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && SUPPORTED_HOSTS.includes(parsed.hostname);
    } catch {
      return false;
    }
  }

  /** Normalizes any settings object into the canonical v2 shape. */
  function sanitizeSettings(raw) {
    const f = raw && typeof raw.features === 'object' ? raw.features : {};
    const okProfile = ['auto', 'native', 'fast', 'balanced', 'extreme', 'custom'];
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      profile: typeof raw.profile === 'string' && okProfile.includes(raw.profile)
        ? raw.profile
        : DEFAULTS.profile,
      customLimit: Number.isFinite(raw.customLimit)
        ? Math.min(200, Math.max(2, raw.customLimit))
        : DEFAULTS.customLimit,
      features: {
        instantScroll: f.instantScroll !== false,
        sidebarOptimization: f.sidebarOptimization !== false,
        telemetryBlock: f.telemetryBlock !== false,
        disableAnimations: f.disableAnimations !== false
      }
    };
  }

  /** Reads settings from storage, filling in defaults for missing keys. */
  async function getSettings() {
    const raw = await store.get(DEFAULTS);
    return sanitizeSettings(raw);
  }

  /** Delivers the current settings to every supported, open tab. */
  async function broadcastSettings() {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter(tab => tab.id && isSupportedUrl(tab.url))
        .map(tab =>
          chrome.tabs.sendMessage(tab.id, { type: 'settingsUpdated', payload: settings })
            .catch(() => { /* tab has no receiver yet — it reads storage on init */ })
        )
    );
  }

  /** Enables/disables the telemetry blocklist ruleset. */
  function setNetworkRulesEnabled(enabled) {
    const options = enabled
      ? { enableRulesetIds: [RULESET_ID] }
      : { disableRulesetIds: [RULESET_ID] };
    try {
      chrome.declarativeNetRequest.updateEnabledRulesets(options);
    } catch { /* not fatal — rules stay in their previous state */ }
  }

  /* ══ Lifecycle ══════════════════════════════════════════════════════ */

  /** Seeds defaults, applies the privacy toggle, injects into open tabs. */
  chrome.runtime.onInstalled.addListener(async () => {
    const raw = await store.get(DEFAULTS);
    const settings = sanitizeSettings(raw);
    await store.set(settings);

    setNetworkRulesEnabled(settings.features.telemetryBlock);
    await injectIntoExistingTabs();
  });

  /** Re-broadcasts settings whenever a relevant key changes. */
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    const expected = chrome.storage.sync ? 'sync' : 'local';
    if (areaName !== expected) return;
    const relevant = Object.keys(changes).some(key => key in DEFAULTS || key === 'features');
    if (relevant) {
      if (changes.features) {
        const f = changes.features.newValue || {};
        setNetworkRulesEnabled(f.telemetryBlock !== false);
      }
      await broadcastSettings();
    }
  });

  /* ══ Open-tab injection ═════════════════════════════════════════════ */

  /**
   * Injects Lumen into ChatGPT tabs that are already open (install / update /
   * dev reload). Chrome only auto-injects content scripts on new page loads.
   * Both scripts carry their own double-injection guards.
   * @returns {Promise<void>}
   */
  async function injectIntoExistingTabs() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter(tab => tab.id && isSupportedUrl(tab.url))
        .map(async tab => {
          try {
            await chrome.scripting.insertCSS({
              target: { tabId: tab.id },
              files: ['src/content/content.css']
            });
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN',
              files: ['src/content/main-world.js']
            });
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['src/content/content.js']
            });
          } catch {
            /* Tab not ready (discarded / loading) — normal injection covers it. */
          }
        })
    );
  }

  /* ══ Uninstall URL ══════════════════════════════════════════════════ */

  /* Lumen never redirects anywhere — including after uninstall. Chrome
     persists the uninstall URL set by any previous version sharing this
     extension ID, so it is explicitly cleared on every startup. */
  try {
    chrome.runtime.setUninstallURL('');
  } catch { /* not fatal */ }
})();
