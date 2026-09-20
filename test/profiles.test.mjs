/**
 * Profile regression tests: every profile trims exactly as documented,
 * using the REAL shipped main-world code.
 */
import { loadMainWorld, makeConv, makeReporter, readSrc } from './helpers.mjs';

const ok = makeReporter('profiles');
const mw = loadMainWorld();
const { trimWithKeep, resolveProfileKeep, countBubbles, autoKeep, isConversationGet } = mw;

/* conversation factory: n messages, message i keeps its index in the text */
function payloadWith(n) {
  const conv = makeConv(n);
  return conv;
}

/* ── Native: never trims ─────────────────────────────────────────────── */
ok(resolveProfileKeep('native', 10, 500) === Infinity, 'native resolves to no cap');
{
  const conv = payloadWith(500);
  const nativeGuard = /settings\.profile === 'native'\)\s*\{\s*return originalFetch\(/.test(readSrc('src/content/main-world.js'));
  ok(nativeGuard, 'fetch wrapper short-circuits native before parsing (pristine passthrough)');
}
/* even if someone forced a trim call, huge keep passes through untouched */
{
  const conv = payloadWith(500);
  const result = trimWithKeep(conv, 5000);
  ok(result.passthrough === true, '500-message payload with huge keep → passthrough');
  ok(result.json === undefined && result.status.totalMessages === 500, 'passthrough reports full totals');
}

/* ── Fast keeps 10 ───────────────────────────────────────────────────── */
{
  const conv = payloadWith(500);
  ok(resolveProfileKeep('fast', 10, 500) === 10, 'fast resolves to 10');
  const result = trimWithKeep(conv, resolveProfileKeep('fast', 10, 500));
  ok(!result.passthrough && result.status.renderedMessages === 10, 'fast trims 500 → 10 rendered');
  ok(result.status.hiddenMessages === 490, 'fast hides 490');
  ok(Object.keys(result.json.mapping).length === 10, 'mapping holds exactly 10 nodes');
}

/* ── Balanced keeps 20 ───────────────────────────────────────────────── */
{
  const conv = payloadWith(500);
  ok(resolveProfileKeep('balanced', 10, 500) === 20, 'balanced resolves to 20 even with stale customLimit=10');
  const result = trimWithKeep(conv, resolveProfileKeep('balanced', 10, 500));
  ok(result.status.renderedMessages === 20, 'balanced trims 500 → 20 rendered');
}

/* ── Extreme keeps 5 ─────────────────────────────────────────────────── */
{
  const conv = payloadWith(500);
  ok(resolveProfileKeep('extreme', 10, 500) === 5, 'extreme resolves to 5 even with stale customLimit=10');
  const result = trimWithKeep(conv, resolveProfileKeep('extreme', 10, 500));
  ok(result.status.renderedMessages === 5, 'extreme trims 500 → 5 rendered');
}

/* ── Custom uses customLimit ─────────────────────────────────────────── */
{
  const conv = payloadWith(500);
  ok(resolveProfileKeep('custom', 42, 500) === 42, 'custom resolves to customLimit');
  const result = trimWithKeep(conv, resolveProfileKeep('custom', 42, 500));
  ok(result.status.renderedMessages === 42, 'custom trims 500 → 42 rendered');
}

/* ── Auto: ≤120 passthrough, >120 adaptive window ────────────────────── */
{
  const small = payloadWith(120);
  ok(resolveProfileKeep('auto', 10, 120) === Infinity, 'auto 120 → native passthrough');
  ok(countBubbles(small) === 120, 'countBubbles counts all visible turns');
  const keepSmall = autoKeep(countBubbles(small));
  const resultSmall = trimWithKeep(small, keepSmall);
  ok(resultSmall.passthrough === true, 'auto 120-message payload passes through untouched');
}
{
  const big = payloadWith(500);
  ok(resolveProfileKeep('auto', 10, 500) === 20, 'auto 500 → window 20');
  ok(autoKeep(500) === 20, 'autoKeep(500) = 20 (worker path)');
  const result = trimWithKeep(big, autoKeep(countBubbles(big)));
  ok(result.status.renderedMessages === 20, 'auto trims 500 → 20 rendered');
}
{
  ok(resolveProfileKeep('auto', 10, 2000) === 40, 'auto 2000 → window 40 (ceiling)');
  ok(resolveProfileKeep('auto', 10, 121) === 20, 'auto 121 → floor window 20');
}

/* ── trim never touches non-conversation payloads ────────────────────── */
ok(trimWithKeep({ foo: 1 }, 10) === null, 'non-conversation payload → null (caller passes through)');
ok(isConversationGet('https://chatgpt.com/backend-api/conversation/abc', 'GET') === true, 'conversation GET matched');
ok(isConversationGet('https://chatgpt.com/backend-api/conversations?offset=0', 'GET') === false, 'list endpoint not matched');
ok(isConversationGet('https://chatgpt.com/backend-api/conversation/abc', 'POST') === false, 'streaming POST never matched');

ok.done();
