/**
 * Pause + DNR decision tests: the master enabled switch must gate the
 * telemetry ruleset together with the feature toggle, and every runtime
 * effect must be revertible when paused.
 */
import { loadServiceWorker, makeReporter, readSrc } from './helpers.mjs';

const ok = makeReporter('pause-dnr');
const sw = loadServiceWorker();
const { shouldBlockTelemetry } = sw.hooks;

/* ── DNR state decision (the 4-state matrix) ─────────────────────────── */
const mk = (enabled, telemetry) => ({
  enabled,
  features: { telemetryBlock: telemetry }
});
ok(shouldBlockTelemetry(mk(true, true)) === true, 'enabled=true  + telemetry=true  → ON');
ok(shouldBlockTelemetry(mk(true, false)) === false, 'enabled=true  + telemetry=false → OFF');
ok(shouldBlockTelemetry(mk(false, true)) === false, 'enabled=false + telemetry=true  → OFF');
ok(shouldBlockTelemetry(mk(false, false)) === false, 'enabled=false + telemetry=false → OFF');

/* ── storage changes recompute DNR from FULL settings ────────────────── */
ok(/syncDnrState\(await getSettings\(\)\)/.test(readSrc('src/background/service-worker.js')),
  'SW storage change handler recomputes DNR from full settings (enabled wins)');

/* ── paused content script: no windowing, no CSS, no loader ──────────── */
const contentSrc = readSrc('src/content/content.js');
ok(/if \(!settings\.enabled\) return Infinity;/.test(contentSrc),
  'content resolveKeep: paused → no DOM windowing');
ok(/setStyleElement\('lumen-perf-core', on \? CORE_CSS : null\)/.test(contentSrc) &&
   /setStyleElement\('lumen-perf-sidebar', on && f\.sidebarOptimization \? SIDEBAR_CSS : null\)/.test(contentSrc) &&
   /setStyleElement\('lumen-perf-visual', on && f\.disableAnimations \? VISUAL_CSS : null\)/.test(contentSrc),
  'all three perf CSS layers are removed when paused / toggled off');
ok(/if \(!settings\.enabled \|\| archive\.exhausted \|\| archive\.loading\) return;/.test(contentSrc),
  'progressive history loader stops while paused');
ok(!/GHOST_CSS/.test(contentSrc),
  'ghost styles are static-only (no duplicated dynamic layer in content.js)');

/* ── paused main-world: no trimming, no scroll patch ─────────────────── */
const mainSrc = readSrc('src/content/main-world.js');
ok(/!\(settings\.enabled && isConversationGet/.test(mainSrc),
  'fetch wrapper bypasses everything while paused');
ok(/applyScrollPatch\(settings\.enabled && settings\.features\.instantScroll\)/.test(mainSrc),
  'scroll patch reverts when paused or instant-scroll off');
ok(/Element\.prototype\.scrollIntoView = nativeScroll\.siv;/.test(mainSrc) &&
   /window\.scrollTo = nativeScroll\.scrollTo;/.test(mainSrc) &&
   /window\.scrollBy = nativeScroll\.scrollBy;/.test(mainSrc),
  'native scroll functions are restored exactly (scrollIntoView, scrollTo, scrollBy)');

/* ── popup master pause reloads the page (no loop: user action only) ──── */
const popupSrc = readSrc('src/popup/popup.js');
ok(/toggle\.addEventListener\('change'[\s\S]*?chrome\.tabs\.reload\(tabId\)/.test(popupSrc),
  'popup master toggle reloads the tab so trimmed conversations refetch pristine');
const swSrc = readSrc('src/background/service-worker.js');
ok(popupSrc.includes('chrome.tabs.reload(tabId)'),
  'popup master toggle reloads the tab so trimmed conversations refetch pristine');
ok(!swSrc.includes('tabs.reload'),
  'service worker never triggers reloads (no reload loops)');
ok(!/setInterval|setTimeout[\s\S]{0,80}reload/.test(popupSrc),
  'no timed reload automation in popup');

/* ── static stylesheet carries no performance rules ───────────────────── */
const css = readSrc('src/content/content.css');
ok(!/content-visibility/.test(css), 'static CSS: no content-visibility rules');
ok(!/backdrop-filter/.test(css), 'static CSS: no backdrop-filter rules');
ok(!/transition:\s*none/.test(css), 'static CSS: no transition-killing rules');
ok(!/scroll-behavior/.test(css), 'static CSS: no scroll-behavior override');
ok(/\.lumen-ghost/.test(css), 'static CSS: archive-turn styles present');

ok.done();
