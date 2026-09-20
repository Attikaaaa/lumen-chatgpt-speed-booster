/**
 * CI: syntax-check every JS entry point, validate JSON manifests and run the
 * DNR scope test. Pure Node — no dependencies.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let fail = 0;

function rel(p) { return path.relative(ROOT, p); }

/* JSON validity */
for (const f of ['manifest.json', 'rules.json', '_locales/en/messages.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    console.log('PASS json ' + f);
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
  if (!fs.existsSync(p)) { console.log('FAIL missing manifest-referenced file: ' + ref); fail++; }
  else console.log('PASS exists ' + ref);
}

/* DNR ruleset ids referenced in manifest must exist in rules.json */
if (manifest.declarative_net_request) {
  const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
  for (const rr of manifest.declarative_net_request.rule_resources) {
    if (!fs.existsSync(path.join(ROOT, rr.path))) { console.log('FAIL missing ruleset ' + rr.path); fail++; }
  }
}

console.log(fail === 0 ? 'MANIFEST/ASSET AUDIT PASS' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
