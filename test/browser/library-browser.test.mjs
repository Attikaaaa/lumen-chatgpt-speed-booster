/**
 * Library browser integration test — drives the REAL shipped
 * library-core.js + library.js in headless Chrome (system Chrome via
 * puppeteer-core, no bundled download).
 *
 * Covered interactions: open/close, current-chat capture across SPA
 * navigations, row rendering, pin toggle, Pinned/All filters, folder
 * creation + folder filtering, search, bulk selection + move, item
 * deletion.
 * Regression guards: items actually appended, All/Pinned handlers live,
 * pin and delete never confused, pinned-first/newest-first sort, and no
 * handler duplication after repeated renders.
 */
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const CHROME = process.env.CHROME_BIN || pickSystemChrome();
function pickSystemChrome() {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
       'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
         '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  throw new Error('No Chrome/Chromium found. Set CHROME_BIN.');
}

const CORE_SRC = fs.readFileSync(path.join(ROOT, 'src/content/library-core.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(ROOT, 'src/content/library.js'), 'utf8');

let failures = 0;
function ok(cond, name) {
  console.log((cond ? 'PASS' : 'FAIL') + ' [library-browser] ' + name);
  if (!cond) failures++;
}

const HOST = `document.querySelector('#lumen-library-host')`;
const SR = sel => `${HOST}.shadowRoot.querySelector('${sel}')`;
const SR_ALL = sel => `[...${HOST}.shadowRoot.querySelectorAll('${sel}')]`;

const PAGE_HTML = `<!doctype html><html><head><title>Intercepted chat</title></head>
<body><nav><a href="/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa">Intercepted chat</a></nav>
<main style="height:2000px">chat body</main></body></html>`;

const AAA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BBB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CCC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', e => { console.log('PAGE ERROR:', e.message); failures++; });

  /* serve fake chatgpt.com /c/ conversation pages so captureCurrent() runs */
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().startsWith('https://chatgpt.com/')) {
      req.respond({ status: 200, contentType: 'text/html', body: PAGE_HTML });
    } else {
      req.continue();
    }
  });

  /* chrome.storage stub persisted through sessionStorage (survives reload);
     prompt always answers "work" */
  await page.evaluateOnNewDocument(() => {
    const read = () => {
      try { return JSON.parse(sessionStorage.getItem('lumen_stub') || '{}'); }
      catch { return {}; }
    };
    const write = obj => sessionStorage.setItem('lumen_stub', JSON.stringify(obj));
    window.chrome = {
      storage: {
        local: {
          get: async key => {
            const o = read();
            return key === 'lumen_library' ? { lumen_library: o.lumen_library ?? null } : {};
          },
          set: async obj => { const o = read(); Object.assign(o, obj); write(o); }
        }
      }
    };
    window.prompt = () => 'work';
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = () => page.evaluate(`(async () => (await window.chrome.storage.local.get('lumen_library')).lumen_library)()`);

  async function openConversation(uuid) {
    await page.goto('https://chatgpt.com/c/' + uuid, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: CORE_SRC });
    await page.addScriptTag({ content: LIB_SRC });
    await sleep(300);
  }

  /* ── 1. load on a /c/ page → auto-capture with sidebar title ───────── */
  await openConversation(AAA);
  ok(await page.evaluate(`!!${HOST}`), 'library host injected');
  let st = await store();
  ok(st && st.chats[AAA] && st.chats[AAA].title === 'Intercepted chat',
    'current conversation auto-captured with sidebar title');

  /* ── 2. open panel ─────────────────────────────────────────────────── */
  await page.click('#lumen-library-host');
  await sleep(150);
  ok(await page.evaluate(`${SR('.panel')}.classList.contains('on')`), 'panel opens');

  /* ── 3. close panel ────────────────────────────────────────────────── */
  await page.evaluate(`${SR('.panel .x')}.click()`);
  await sleep(100);
  ok(await page.evaluate(`!${SR('.panel')}.classList.contains('on')`), 'panel closes via ✕');
  ok(await page.evaluate(`${HOST}.shadowRoot.querySelector('button').style.display !== 'none'`),
    'launcher visible again after close');
  await page.click('#lumen-library-host');
  await sleep(150);

  /* ── 4+5. + current keeps one row, row renders the title ───────────── */
  await page.evaluate(`${SR('.addcur')}.click()`);
  await sleep(200);
  let rows = await page.evaluate(`${SR_ALL('.item')}.length`);
  ok(rows === 1, '+ current keeps exactly one row for the open chat');
  ok(await page.evaluate(`${SR('.item .t')}.textContent`) === 'Intercepted chat',
    'row renders the captured title');

  /* ── navigate to two more conversations (SPA-style re-captures) ────── */
  await openConversation(BBB);
  await openConversation(CCC);
  st = await store();
  ok(Object.keys(st.chats).length === 3, 'three conversations captured across navigations');

  /* ── 6+7. pin the OLDEST chat; persists ────────────────────────────── */
  await page.evaluate(`${SR_ALL('.item .pin')}[2].click()`); /* aaaa = oldest */
  await sleep(200);
  st = await store();
  ok(st.chats[AAA].pinned === true, 'pin click persists pinned=true');

  /* ── sort regression: pinned first, then newest first ──────────────── */
  const order = await page.evaluate(`${SR_ALL('.item')}.map(i => i.dataset.id)`);
  ok(JSON.stringify(order) === JSON.stringify([AAA, CCC, BBB]),
    'sort: pinned first, then newest first — got ' + JSON.stringify(order));

  /* ── pin/delete never confused: delete must not toggle pin ─────────── */
  const cccPinnedBefore = st.chats[CCC].pinned;
  await page.evaluate(`${SR_ALL('.item .del')}[0].click()`); /* deletes AAA */
  await sleep(200);
  st = await store();
  ok(!st.chats[AAA] && st.chats[CCC] && st.chats[CCC].pinned === cccPinnedBefore,
    'delete removes the row and never touches pin state');

  /* ── 8. Pinned filter ──────────────────────────────────────────────── */
  await page.evaluate(`${SR('.fchip[data-chip=pinned]')}.click()`);
  await sleep(100);
  ok(await page.evaluate(`${SR('.fchip[data-chip=pinned]')}.classList.contains('on')`) &&
     (await store()).chats[AAA] === undefined && (await page.evaluate(`${SR_ALL('.item')}.length`)) === 0,
    'Pinned filter chip toggles on (pinned chat was deleted → empty list)');

  /* ── 9. All filter resets ──────────────────────────────────────────── */
  await page.evaluate(`${SR('.fchip[data-chip=all]')}.click()`);
  await sleep(100);
  rows = await page.evaluate(`${SR_ALL('.item')}.length`);
  ok(rows === 2 && await page.evaluate(`${SR('.fchip[data-chip=all]')}.classList.contains('on')`),
    'All chip resets the filter (2 chats remain)');

  /* ── 10. folder creation via + folder (prompt answers "work") ──────── */
  await page.evaluate(`${SR('.addf')}.click()`);
  await sleep(200);
  st = await store();
  const work = st.folders.find(f => f.name === 'work');
  ok(Boolean(work), '+ folder creates the "work" folder');
  ok(await page.evaluate(`${SR_ALL('.fchip')}.length`) === 3, 'folder chip renders (All, Pinned, work)');

  /* ── 11. folder filtering ──────────────────────────────────────────── */
  const workChipSel = '.fchip[data-folder="' + (work ? work.id : '') + '"]';
  await page.evaluate(`${SR(workChipSel)}.click()`);
  await sleep(100);
  rows = await page.evaluate(`${SR_ALL('.item')}.length`);
  ok(rows === 0, 'folder filter shows no rows for unfiled chats');
  await page.evaluate(`${SR('.fchip[data-chip=all]')}.click()`);
  await sleep(100);

  /* ── 12. search by title/no-match ──────────────────────────────────── */
  await page.evaluate(`(() => { const i = ${SR('.tools input')}; i.value = 'intercepted'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);
  rows = await page.evaluate(`${SR_ALL('.item')}.length`);
  ok(rows === 2, 'search by title matches both captured chats');
  await page.evaluate(`(() => { const i = ${SR('.tools input')}; i.value = 'zzz-nomatch'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);
  ok(await page.evaluate(`${SR_ALL('.item')}.length`) === 0, 'search with no match empties the list');
  await page.evaluate(`(() => { const i = ${SR('.tools input')}; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);

  /* ── 13+14. bulk select + bulk move (prompt answers "work") ────────── */
  await page.evaluate(`${SR('.item input[type=checkbox]')}.click()`);
  await sleep(100);
  ok(await page.evaluate(`${SR('.bulk')}.classList.contains('on')`), 'bulk bar appears on selection');
  await page.evaluate(`${SR('.bmove')}.click()`);
  await sleep(200);
  st = await store();
  const workId = st.folders.find(f => f.name === 'work').id;
  ok(Object.values(st.chats).filter(c => c.folderId === workId).length === 1,
    'bulk move assigns the selection to the prompted folder');

  /* ── handler duplication guard: repeated renders must not stack them ── */
  for (const chip of ['.fchip[data-chip=all]', '.fchip[data-chip=pinned]', '.fchip[data-chip=all]']) {
    await page.evaluate(`${SR(chip)}.click()`);
    await sleep(60);
  }
  const pinnedBefore = Object.values((await store()).chats).filter(c => c.pinned).length;
  await page.evaluate(`${SR_ALL('.item .pin')}[0].click()`);
  await sleep(200);
  const pinnedAfter = Object.values((await store()).chats).filter(c => c.pinned).length;
  ok(Math.abs(pinnedAfter - pinnedBefore) === 1,
    'repeated renders do not duplicate handlers (pin toggles exactly once)');

  /* ── 15. item deletion ─────────────────────────────────────────────── */
  st = await store();
  const beforeDelete = Object.keys(st.chats).length;
  await page.evaluate(`${SR_ALL('.item .del')}[0].click()`);
  await sleep(200);
  st = await store();
  ok(Object.keys(st.chats).length === beforeDelete - 1,
    'item ✕ deletes exactly one chat');

  await page.screenshot({ path: path.join(__dirname, 'library-browser-final.png') });
  await browser.close();

  console.log(failures === 0 ? '\nLIBRARY BROWSER TEST PASS' : `\n${failures} LIBRARY BROWSER CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
