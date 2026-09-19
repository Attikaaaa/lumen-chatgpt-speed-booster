/**
 * Lumen — ChatGPT Speed Booster · background service worker.
 * Seeds default settings and broadcasts changes to open ChatGPT tabs.
 */

(() => {
  'use strict';

  /* ══ Constants ══════════════════════════════════════════════════════ */

  /** Default user settings — mirrored by the popup and the content script. */
  const DEFAULTS = Object.freeze({ enabled: true, limit: 10 });

  /** Hostnames Lumen operates on. */
  const SUPPORTED_HOSTS = ['chatgpt.com', 'chat.openai.com'];

  /** Settings storage (sync keeps preferences across devices). */
  const store = chrome.storage.sync || chrome.storage.local;

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

  /**
   * Reads settings from storage, filling in defaults for missing keys.
   * @returns {Promise<{enabled: boolean, limit: number}>}
   */
  async function getSettings() {
    const raw = await store.get(DEFAULTS);
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      limit: Number.isFinite(raw.limit) ? raw.limit : DEFAULTS.limit
    };
  }

  /**
   * Delivers the current settings to every supported, open tab.
   * @returns {Promise<void>}
   */
  async function broadcastSettings() {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter(tab => tab.id && isSupportedUrl(tab.url))
        .map(tab =>
          /* Tabs without a live content script (loaded before install /
             reload) reject asynchronously — swallow that, it's expected. */
          chrome.tabs.sendMessage(tab.id, { type: 'settingsUpdated', payload: settings })
            .catch(() => {})
        )
    );
  }

/* ══ Lifecycle ══════════════════════════════════════════════════════ */

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

/** Seeds defaults so every reader can rely on a complete settings object. */
chrome.runtime.onInstalled.addListener(async () => {
  const raw = await store.get(DEFAULTS);
  await store.set({
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    limit: Number.isFinite(raw.limit) ? raw.limit : DEFAULTS.limit
  });
  await injectIntoExistingTabs();
});

  /** Re-broadcasts settings whenever a relevant key changes. */
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    const expected = chrome.storage.sync ? 'sync' : 'local';
    if (areaName !== expected) return;
    const relevant = Object.keys(changes).some(key => key in DEFAULTS);
    if (relevant) await broadcastSettings();
  });

  try { chrome.runtime.setUninstallURL(''); } catch { /* ignore */ }
})();
