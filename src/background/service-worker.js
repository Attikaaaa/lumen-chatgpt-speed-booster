/**
 * Lumen — ChatGPT Speed Booster · background service worker.
 * Seeds default settings, broadcasts changes to open ChatGPT tabs, and
 * drives the telemetry ruleset from (master enabled AND telemetryBlock).
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

  /** Hostnames Lumen operates on. */
  const SUPPORTED_HOSTS = ['chatgpt.com', 'chat.openai.com'];

  /** Settings storage (sync keeps preferences across devices). */
  const store = chrome.storage.sync || chrome.storage.local;

  const RULESET_ID = 'network_rules';

  /** Content-script files injected into MAIN world — mirrors the manifest. */
  const MAIN_WORLD_SCRIPTS = Object.freeze(['src/content/main-world.js']);

  /** Isolated content scripts, in manifest order (content → core → library). */
  const ISOLATED_SCRIPTS = Object.freeze([
    'src/content/content.js',
    'src/content/library-core.js',
    'src/content/library.js'
  ]);

  /** Static stylesheet (always-safe rules only — see content.css). */
  const STATIC_CSS_FILES = Object.freeze(['src/content/content.css']);

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

  /** Reads settings from storage, filling in defaults for missing keys. */
  async function getSettings() {
    const raw = await store.get(DEFAULTS);
    return sanitizeSettings(raw);
  }

  /**
   * Telemetry ruleset state — the master pause always wins:
   * blocking is active only while Lumen is enabled AND the feature is on.
   * @param {{enabled: boolean, features: {telemetryBlock: boolean}}} settings
   * @returns {boolean}
   */
  function shouldBlockTelemetry(settings) {
    return Boolean(settings.enabled && settings.features.telemetryBlock);
  }

  /** Applies the telemetry ruleset decision for the given settings. */
  function syncDnrState(settings) {
    const on = shouldBlockTelemetry(settings);
    const options = on
      ? { enableRulesetIds: [RULESET_ID] }
      : { disableRulesetIds: [RULESET_ID] };
    try {
      chrome.declarativeNetRequest.updateEnabledRulesets(options);
    } catch { /* not fatal — rules stay in their previous state */ }
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

  /* ══ Lifecycle ══════════════════════════════════════════════════════ */

  /** Seeds defaults, applies the privacy toggle, injects into open tabs. */
  chrome.runtime.onInstalled.addListener(async () => {
    const raw = await store.get(DEFAULTS);
    const settings = sanitizeSettings(raw);
    await store.set(settings);

    syncDnrState(settings);
    await injectIntoExistingTabs();
  });

  /** Re-broadcasts settings whenever a relevant key changes. */
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    const expected = chrome.storage.sync ? 'sync' : 'local';
    if (areaName !== expected) return;
    const relevant = Object.keys(changes).some(key => key in DEFAULTS || key === 'features');
    if (relevant) {
      /* Recompute the DNR decision from the FULL settings so that both the
         master pause and the telemetry toggle always take effect. */
      syncDnrState(await getSettings());
      await broadcastSettings();
    }
  });

  /* ══ Open-tab injection ═════════════════════════════════════════════ */

  /**
   * Injects Lumen into ChatGPT tabs that are already open (install / update /
   * dev reload). Chrome only auto-injects content scripts on new page loads.
   * Every script carries its own double-injection guard. The file lists
   * mirror manifest content_scripts; a CI test enforces they cannot drift.
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
              files: [...STATIC_CSS_FILES]
            });
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN',
              files: [...MAIN_WORLD_SCRIPTS]
            });
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: [...ISOLATED_SCRIPTS]
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

  /* ══ Test hooks (never active in the browser) ═══════════════════════ */

  if (globalThis.__LUMEN_EXPOSE_TEST_HOOKS__) {
    globalThis.__LUMEN_TEST_SW__ = {
      DEFAULTS, PROFILES, PROFILE_LIMITS,
      sanitizeSettings, resolveProfileKeep, shouldBlockTelemetry,
      MAIN_WORLD_SCRIPTS, ISOLATED_SCRIPTS, STATIC_CSS_FILES
    };
  }
})();
