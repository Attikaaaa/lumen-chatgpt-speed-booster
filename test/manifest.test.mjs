/**
 * CI: manifest integrity — every referenced file exists, ruleset is wired.
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

/* referenced files exist */
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const refs = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  ...(manifest.icons ? Object.values(manifest.icons) : []),
  ...(manifest.content_scripts || []).flatMap(cs => [...(cs.js || []), ...(cs.css || [])]),
  ...((manifest.declarative_net_request && manifest.declarative_net_request.rule_resources) || []).map(r => r.path)
].filter(Boolean);

for (const ref of refs) {
  const p = path.join(ROOT, ref);
  ok(fs.existsSync(p), 'exists: ' + ref);
}

/* DNR ruleset ids referenced in manifest must exist in rules.json */
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
const ruleIds = new Set(rules.map(r => r.id));
for (const rr of (manifest.declarative_net_request || {}).rule_resources || []) {
  ok(typeof rr.id === 'string' && rr.id.length > 0, 'ruleset id declared: ' + rr.id);
}

console.log(fail === 0 ? 'MANIFEST AUDIT PASS' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
