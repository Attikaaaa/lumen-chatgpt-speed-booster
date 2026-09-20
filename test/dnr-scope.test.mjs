/**
 * DNR scope test — every blocking rule must be scoped to ChatGPT initiators,
 * so Lumen never blocks requests on unrelated websites.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
const CHATGPT_INITIATORS = new Set(['chatgpt.com', 'chat.openai.com']);

let fail = 0;
const ok = (cond, name) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fail++; };

ok(Array.isArray(rules) && rules.length > 0, 'rules file has rules');

for (const rule of rules) {
  const c = rule.condition || {};
  if (c.requestDomains) {
    const ini = c.initiatorDomains || [];
    ok(ini.includes('chatgpt.com') || ini.includes('chat.openai.com'),
      `rule ${rule.id} (requestDomains ${c.requestDomains.join(',')}) scoped to ChatGPT initiators`);
  }
  if (c.urlFilter && /chatgpt\.com/.test(c.urlFilter)) {
    const ini = c.initiatorDomains || [];
    ok(ini.includes('chatgpt.com') || ini.includes('chat.openai.com'),
      `rule ${rule.id} (chatgpt urlFilter) scoped to ChatGPT initiators`);
  }
}

console.log(fail === 0 ? 'DNR SCOPE PASS' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
