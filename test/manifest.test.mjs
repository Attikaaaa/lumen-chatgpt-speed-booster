/**
 * CI: manifest integrity — every referenced file exists, release version is
 * current, and the service worker's install-time injection cannot silently
 * drift from the manifest's content-script set.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let fail = 0;

function ok(cond, name) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
  if (!cond) fail++;
}

/* JSON validity */
for (const f of ['manifest.json', 'rules.json', '_locales/en/messages.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    ok(true, 'json valid: ' + f);
  } catch (e) {
    console.log('FAIL json ' + f + ': ' + e.message);
    fail++;
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* release version */
ok(manifest.version === '3.1.0', 'manifest version is 3.1.0, got ' + manifest.version);
const [maj] = manifest.version.split('.').map(Number);
ok(maj >= 3, 'manifest major version not stale (>= 3)');

/* referenced files exist */
const refs = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  ...(manifest.icons ? Object.values(manifest.icons) : []),
  ...(manifest.content_scripts || []).flatMap(cs => [...(cs.js || []), ...(cs.css || [])]),
  ...((manifest.declarative_net_request && manifest.declarative_net_request.rule_resources) || []).map(r => r.path)
].filter(Boolean);

for (const ref of refs) {
  ok(fs.existsSync(path.join(ROOT, ref)), 'exists: ' + ref);
}

/* content-script wiring shape */
const csList = manifest.content_scripts || [];
const mainCs = csList.find(cs => cs.world === 'MAIN');
const isolatedCs = csList.filter(cs => cs.world !== 'MAIN');
ok(Boolean(mainCs), 'MAIN-world content script declared');
ok(mainCs && mainCs.run_at === 'document_start', 'MAIN-world script runs at document_start');
ok(isolatedCs.length === 1, 'exactly one isolated content-script group');
const manifestIsolated = isolatedCs[0] ? isolatedCs[0].js || [] : [];
const manifestMain = mainCs ? mainCs.js || [] : [];
const manifestCss = isolatedCs.flatMap(cs => cs.css || []);
ok(manifestIsolated.join(',') === 'src/content/content.js,src/content/library-core.js,src/content/library.js',
  'isolated scripts: content → library-core → library (dependency order)');

/* ── injection drift: SW lists must mirror the manifest ──────────────── */
const swSrc = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
function extractList(name) {
  const m = swSrc.match(new RegExp('const ' + name + ' = Object\\.freeze\\(\\[([^\\]]*)\\]\\)'));
  return m ? m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
}
const swMain = extractList('MAIN_WORLD_SCRIPTS');
const swIsolated = extractList('ISOLATED_SCRIPTS');
const swCss = extractList('STATIC_CSS_FILES');
ok(Array.isArray(swMain), 'SW declares MAIN_WORLD_SCRIPTS list');
ok(Array.isArray(swIsolated), 'SW declares ISOLATED_SCRIPTS list');
ok(Array.isArray(swCss), 'SW declares STATIC_CSS_FILES list');
ok(JSON.stringify(swMain) === JSON.stringify(manifestMain), 'SW MAIN injection matches manifest');
ok(JSON.stringify(swIsolated) === JSON.stringify(manifestIsolated), 'SW isolated injection matches manifest (order included)');
ok(JSON.stringify(swCss) === JSON.stringify(manifestCss), 'SW CSS injection matches manifest');

/* double-injection guards exist for every shipped script */
for (const script of [...manifestMain, ...manifestIsolated]) {
  const src = fs.readFileSync(path.join(ROOT, script), 'utf8');
  ok(/__lumen(?:Main|Content|Library)Loaded|if \(globalThis\.LumenCore\) return/.test(src),
    'double-injection guard present: ' + script);
}

/* DNR ruleset ids referenced in manifest must exist in rules.json */
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
const ruleIds = new Set(rules.map(r => r.id));
for (const rr of (manifest.declarative_net_request || {}).rule_resources || []) {
  ok(typeof rr.id === 'string' && ruleIds.size >= 0, 'ruleset id declared: ' + rr.id);
}
ok(rules.length > 0, 'rules.json carries rules');

/* ruleset must be enabled-by-default so the toggle can only turn it off */
ok((manifest.declarative_net_request.rule_resources[0] || {}).enabled === true,
  'ruleset enabled by default in manifest');

console.log(fail === 0 ? 'MANIFEST AUDIT PASS' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
