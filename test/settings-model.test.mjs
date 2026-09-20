/**
 * Settings-model parity: the LUMEN-SETTINGS-MODEL block must be
 * byte-identical in every execution context, and its semantics must hold
 * (defaults, malformed input, invalid profile, limit bounds, features).
 */
import { readSrc, settingsModelBlock, loadMainWorld, loadContent, loadServiceWorker, makeReporter } from './helpers.mjs';

const ok = makeReporter('settings-model');

const CONTEXTS = [
  ['service-worker', 'src/background/service-worker.js'],
  ['main-world', 'src/content/main-world.js'],
  ['content', 'src/content/content.js'],
  ['popup', 'src/popup/popup.js']
];

/* ── 1. byte-identical model block everywhere ────────────────────────── */
const blocks = CONTEXTS.map(([name, file]) => {
  const block = settingsModelBlock(readSrc(file));
  ok(block !== null, 'settings-model block present in ' + name);
  return block;
});
const reference = blocks[0];
for (let i = 1; i < blocks.length; i++) {
  ok(blocks[i] === reference, 'model block byte-identical: ' + CONTEXTS[i][0]);
}

/* ── 2. semantics, executed from the shipped main-world code ─────────── */
const mw = loadMainWorld();
const { sanitizeSettings, resolveProfileKeep, DEFAULTS, clampLimit } = mw;

/* defaults */
ok(DEFAULTS.profile === 'auto' && DEFAULTS.customLimit === 10 && DEFAULTS.enabled === true, 'DEFAULTS shape');
const clean = sanitizeSettings({});
ok(
  clean.enabled === true && clean.profile === 'auto' && clean.customLimit === 10 &&
  clean.features.instantScroll && clean.features.sidebarOptimization &&
  clean.features.telemetryBlock && clean.features.disableAnimations,
  'missing input falls back to defaults'
);

/* malformed input */
ok(sanitizeSettings(null).profile === 'auto', 'null input tolerated');
ok(sanitizeSettings(undefined).enabled === true, 'undefined input tolerated');
ok(sanitizeSettings('garbage').customLimit === 10, 'string input tolerated');
ok(sanitizeSettings({ profile: 42 }).profile === 'auto', 'non-string profile rejected');
ok(sanitizeSettings({ profile: 'turbo' }).profile === 'auto', 'invalid profile name rejected');
ok(sanitizeSettings({ customLimit: 'banana' }).customLimit === 10, 'non-numeric customLimit falls back');

/* customLimit bounds (2..200) */
ok(sanitizeSettings({ customLimit: 1 }).customLimit === 2, 'customLimit below 2 clamps up to 2');
ok(sanitizeSettings({ customLimit: 0 }).customLimit === 2, 'customLimit 0 clamps to 2');
ok(sanitizeSettings({ customLimit: -50 }).customLimit === 2, 'negative customLimit clamps to 2');
ok(sanitizeSettings({ customLimit: 201 }).customLimit === 200, 'customLimit above 200 clamps down');
ok(sanitizeSettings({ customLimit: 10.7 }).customLimit === 11, 'fractional customLimit rounds');

/* features: missing + partial objects */
const partial = sanitizeSettings({ features: { instantScroll: false } });
ok(partial.features.instantScroll === false, 'partial feature false respected');
ok(partial.features.telemetryBlock === true, 'missing feature defaults to true');
ok(sanitizeSettings({ features: 'nope' }).features.instantScroll === true, 'garbage features object ignored');

/* ── 3. profile resolution semantics ─────────────────────────────────── */
ok(resolveProfileKeep('native', 999, 500) === Infinity, 'native → no cap');
ok(resolveProfileKeep('auto', 10, 120) === Infinity, 'auto ≤120 → native');
ok(resolveProfileKeep('auto', 10, 121) === 20, 'auto 121 → minimum window 20');
ok(resolveProfileKeep('auto', 10, 500) === 20, 'auto 500 → clamp(round(12.5)=13 → 20)');
ok(resolveProfileKeep('auto', 10, 2000) === 40, 'auto 2000 → maximum window 40');
ok(resolveProfileKeep('fast', 99, 0) === 10, 'fast → 10 (stale customLimit ignored)');
ok(resolveProfileKeep('balanced', 99, 0) === 20, 'balanced → 20 (stale customLimit ignored)');
ok(resolveProfileKeep('extreme', 99, 0) === 5, 'extreme → 5 (stale customLimit ignored)');
ok(resolveProfileKeep('custom', 42, 0) === 42, 'custom → user customLimit');

/* content script and service worker resolve identically */
const contentHooks = loadContent();
ok(typeof contentHooks.resolveProfileKeep === 'function', 'content.js exposes model');
for (const profile of ['native', 'auto', 'fast', 'balanced', 'extreme', 'custom']) {
  const a = resolveProfileKeep(profile, 33, 300);
  const b = contentHooks.resolveProfileKeep(profile, 33, 300);
  ok(a === b, 'content/main resolve identically for ' + profile);
}
const sw = loadServiceWorker();
for (const profile of ['native', 'auto', 'fast', 'balanced', 'extreme', 'custom']) {
  const a = resolveProfileKeep(profile, 33, 300);
  const b = sw.hooks.resolveProfileKeep(profile, 33, 300);
  ok(a === b, 'sw/main resolve identically for ' + profile);
}

ok.done();
