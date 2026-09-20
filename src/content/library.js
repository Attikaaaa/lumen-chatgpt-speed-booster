/**
 * Lumen Library — organization panel (folders, pins, search, bulk actions).
 *
 * Architecture:
 *  - Lives in its own host element with a shadow root, so it neither leaks
 *    styles into ChatGPT nor inherits ChatGPT CSS.
 *  - Never mutates ChatGPT-managed DOM. The sidebar is only read.
 *  - All state lives in chrome.storage.local under `lumen_library`.
 *  - Auto-captures the conversation id + title of every chat you visit, so
 *    the library fills itself as you work.
 */

(() => {
  'use strict';

  if (window.__lumenLibraryLoaded) return;
  window.__lumenLibraryLoaded = true;

  const CORE = globalThis.LumenCore;
  const STORE_KEY = 'lumen_library';

  const HOST_ID = 'lumen-library-host';
  const PANEL_W = 320;

  let state = CORE.empty();
  let open = false;
  let filter = { query: '', folderId: null, pinnedOnly: false };
  let host = null;
  let root = null;

  /* ══ Storage ════════════════════════════════════════════════════════ */

  async function load() {
    try {
      const data = await chrome.storage.local.get(STORE_KEY);
      state = CORE.sanitize(data[STORE_KEY]);
    } catch {
      state = CORE.empty();
    }
  }

  async function save() {
    await chrome.storage.local.set({ [STORE_KEY]: state });
  }

  /* ══ Auto-capture current conversation ══════════════════════════════ */

  let lastCaptured = '';

  function captureCurrent() {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (!match) return;
    const convId = match[1];
    if (convId === lastCaptured) return;
    lastCaptured = convId;

    /* prefer ChatGPT's own document title, minus the " - ChatGPT" suffix */
    let title = (document.title || '').replace(/\s*[-–|]\s*ChatGPT\s*$/i, '').trim();
    if (!title) {
      const h = document.querySelector('h1');
      title = h ? h.textContent.trim() : '';
    }
    if (!title) title = 'Conversation ' + convId.slice(0, 8);

    state = CORE.addChat(state, convId, title);
    save().then(render);
  }

  /* ══ Panel UI (shadow DOM) ══════════════════════════════════════════ */

  const CSS = `
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    :host { all: initial; }
    .panel {
      position: fixed; top: 0; right: 0; width: ${PANEL_W}px; height: 100vh;
      background: #141414; color: #f2f2f2; z-index: 2147483000;
      display: flex; flex-direction: column;
      border-left: 1px solid #2a2a2a;
      box-shadow: -12px 0 32px rgba(0,0,0,.35);
      font-size: 13px; line-height: 1.45;
    }
    .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #2a2a2a; }
    .hd b { font-size: 14px; }
    .hd .x { background: none; border: 0; color: #9b9b9c; font-size: 16px; cursor: pointer; }
    .tools { display: flex; gap: 6px; padding: 10px 14px; border-bottom: 1px solid #2a2a2a; }
    .tools input[type=text] {
      flex: 1; height: 30px; padding: 0 10px; border: 1px solid #3a3a3a;
      border-radius: 8px; background: #1c1c1c; color: #f2f2f2; outline: none; font-size: 12.5px;
    }
    .tools input:focus { border-color: #0091ff; }
    .tools button {
      height: 30px; padding: 0 10px; border: 1px solid #3a3a3a; border-radius: 8px;
      background: #1c1c1c; color: #f2f2f2; cursor: pointer; font-size: 12px;
    }
    .tools button:hover { background: #262626; }
    .folders { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px; border-bottom: 1px solid #2a2a2a; }
    .fchip {
      display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px;
      border: 1px solid #3a3a3a; border-radius: 999px; background: transparent;
      color: #cfcfcf; font-size: 11.5px; cursor: pointer;
    }
    .fchip.on { border-color: #0091ff; color: #7fc4ff; }
    .fchip .fdel { color: #777; margin-left: 2px; }
    .fchip .fdel:hover { color: #ff6b6b; }
    .list { flex: 1; overflow-y: auto; padding: 8px 10px; }
    .empty { padding: 26px 12px; text-align: center; color: #777; font-size: 12px; }
    .item {
      display: flex; align-items: center; gap: 8px; padding: 9px 10px; margin-bottom: 6px;
      border: 1px solid #2a2a2a; border-radius: 10px; background: #1a1a1a;
    }
    .item input[type=checkbox] { accent-color: #0091ff; }
    .item .meta { flex: 1; min-width: 0; }
    .item .t { display: block; font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item .f { display: block; font-size: 11px; color: #8f8f8f; }
    .item select {
      max-width: 92px; height: 26px; border: 1px solid #3a3a3a; border-radius: 6px;
      background: #141414; color: #cfcfcf; font-size: 11px; outline: none;
    }
    .item .pin { color: #9b9b9c; background: none; border: 0; cursor: pointer; font-size: 13px; }
    .item .pin.on { color: #ffc94d; }
    .item .del { color: #777; }
    .item .del:hover { color: #ff6b6b; }
    .bulk {
      display: none; align-items: center; gap: 6px; padding: 8px 14px;
      border-top: 1px solid #2a2a2a; background: #191919;
    }
    .bulk.on { display: flex; }
    .bulk span { flex: 1; font-size: 11.5px; color: #9b9b9c; }
    .bulk button {
      height: 28px; padding: 0 10px; border: 1px solid #3a3a3a; border-radius: 7px;
      background: #1c1c1c; color: #f2f2f2; font-size: 11.5px; cursor: pointer;
    }
    .bulk button:hover { background: #262626; }
    .ft { padding: 8px 14px 12px; border-top: 1px solid #2a2a2a; color: #777; font-size: 11px; }
  `;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;';
    root = host.attachShadow({ mode: 'open' });

    const btn = document.createElement('button');
    btn.textContent = 'Lumen';
    btn.style.cssText = [
      'height:30px;padding:0 12px;border-radius:999px;border:1px solid #3a3a3a;',
      'background:rgba(20,20,20,.92);color:#9b9b9c;font:600 11px/1 system-ui,sans-serif;',
      'letter-spacing:.08em;cursor:pointer'
    ].join(';');
    btn.addEventListener('click', toggle);
    root.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="hd"><b>Lumen Library</b><button class="x" title="close">✕</button></div>
      <div class="tools">
        <input type="text" placeholder="Search…" />
        <button class="addcur" title="Save the currently open chat">+ current</button>
        <button class="addf" title="New folder">+ folder</button>
      </div>
      <div class="folders"></div>
      <div class="list"></div>
      <div class="bulk"><span></span><button class="bmove">Move…</button><button class="bdel">Delete</button></div>
      <div class="ft">Folders, pins and tags are stored locally in your browser.</div>
    `;
    root.appendChild(panel);

    document.documentElement.appendChild(host);

    panel.querySelector('.x').addEventListener('click', toggle);
    panel.querySelector('.addcur').addEventListener('click', () => {
      lastCaptured = '';
      captureCurrent();
      open = true;
      panel.style.display = 'flex';
      render();
    });
    panel.querySelector('.addf').addEventListener('click', () => {
      const name = prompt('Folder name:');
      if (!name) return;
      const res = CORE.addFolder(state, name.trim());
      state = res.state;
      save().then(render);
    });
    panel.querySelector('input[type=text]').addEventListener('input', e => {
      filter.query = e.target.value;
      render();
    });
    panel.querySelector('.bmove').addEventListener('click', () => {
      bulkApply(selectedFolderId());
    });
    panel.querySelector('.bdel').addEventListener('click', () => bulkDelete());
  }

  function toggle() {
    open = !open;
    ensureHost();
    root.querySelector('.panel').style.display = open ? 'flex' : 'none';
    if (open) { captureCurrent(); render(); }
  }

  function selectedFolderId() {
    const chips = root.querySelectorAll('.fchip');
    const on = root.querySelector('.fchip.on');
    return on ? on.dataset.folder || null : null;
  }

  function bulkApply(folderId) {
    const ids = [...root.querySelectorAll('.item input[type=checkbox]:checked')]
      .map(cb => cb.dataset.id);
    for (const id of ids) state = CORE.setFolder(state, id, folderId || null);
    save().then(() => { clearSelection(); render(); });
  }

  function bulkDelete() {
    const ids = [...root.querySelectorAll('.item input[type=checkbox]:checked')]
      .map(cb => cb.dataset.id);
    for (const id of ids) state = CORE.removeChat(state, id);
    save().then(() => { clearSelection(); render(); });
  }

  function clearSelection() {
    root.querySelectorAll('.item input[type=checkbox]:checked')
      .forEach(cb => { cb.checked = false; });
  }

  function onFoldersClick(event) {
    const chip = event.target.closest('.fchip');
    if (!chip) return;
    if (event.target.classList.contains('fdel')) {
      event.stopPropagation();
      state = CORE.removeFolder(state, chip.dataset.folder || '');
      save().then(render);
      return;
    }
    /* toggle the filter */
    const id = chip.dataset.folder || null;
    filter.folderId = filter.folderId === id ? null : id;
    render();
  }

  function onListClick(event) {
    const item = event.target.closest('.item');
    if (!item) return;
    const convId = item.dataset.id;

    const pin = event.target.closest('.pin');
    if (pin) {
      state = CORE.togglePin(state, convId);
      save().then(() => { render(); });
      return;
    }
    const del = event.target.closest('.del');
    if (del) {
      state = CORE.removeChat(state, convId);
      save().then(render);
      return;
    }
    /* plain click = deliver this chat into Lumen performance flow? No —
       plain click opens the conversation on ChatGPT. */
    window.location.href = '/c/' + convId;
  }

  function onListChange(event) {
    const select = event.target.closest('select.fassign');
    if (!select) return;
    const item = event.target.closest('.item');
    if (!item) return;
    state = CORE.setFolder(state, item.dataset.id, select.value || null);
    save().then(render);
  }

  /* ══ Render ═════════════════════════════════════════════════════════ */

  function render() {
    if (!root) return;
    const foldersEl = root.querySelector('.folders');
    const list = root.querySelector('.list');

    /* folder chips */
    foldersEl.textContent = '';
    const mk = (label, folderId, cls) => {
      const b = document.createElement('button');
      b.className = 'fchip' + (cls || '');
      if (folderId) b.dataset.folder = folderId;
      b.textContent = label;
      foldersEl.appendChild(b);
      return b;
    };
    mk('All', null, filter.folderId === null ? 'on' : '');
    mk('★ Pinned', '__pinned', filter.pinnedOnly ? 'on' : '');
    for (const f of state.folders) {
      const b = mk(f.name + ' ✕', f.id, filter.folderId === f.id ? 'on' : '');
      const del = document.createElement('span');
      del.className = 'fdel';
      del.textContent = '✕';
      del.title = 'Delete folder';
      b.appendChild(del);
      b.addEventListener('click', e => {
        if (e.target === del) {
          state = CORE.removeFolder(state, f.id);
          save().then(render);
        } else {
          filter.folderId = filter.folderId === f.id ? null : f.id;
          render();
        }
      }, { once: false });
    }

    /* chat rows */
    list.textContent = '';
    const query = (root.querySelector('input[type=text]').value || '').toLowerCase();
    const ids = [];
    for (const id of Object.keys(state.chats)) {
      const c = state.chats[id];
      if (query && !c.title.toLowerCase().includes(query)) continue;
      if (filter.folderId && c.folderId !== filter.folderId) continue;
      ids.push(id);
    }
    ids.sort((a, b) => {
      const ca = state.chats[a], cb = state.chats[b];
      const pinDiff = (cb.pinned ? 1 : 0) - (ca.pinned ? 1 : 0);
      if (pinDiff) return -pinDiff;
      return (cb.added || 0) - (ca.added || 0);
    });

    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No saved chats yet — open a conversation and press “+ current”.';
      list.appendChild(empty);
      return;
    }

    for (const id of ids) {
      const c = state.chats[id];
      const item = document.createElement('div');
      item.className = 'item';
      item.dataset.id = id;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.id = id;
      check.addEventListener('change', updateBulkBar);
      item.appendChild(check);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = c.title;
      const f = document.createElement('span');
      f.className = 'f';
      const folder = state.folders.find(x => x.id === c.folderId);
      f.textContent = (c.pinned ? '★ ' : '') + (folder ? folder.name : 'Unfiled') +
        (c.tags.length ? ' · ' + c.tags.join(', ') : '');
      meta.append(t, f);
      item.appendChild(meta);

      const pin = document.createElement('button');
      pin.className = 'pin' + (c.pinned ? ' on' : '');
      pin.textContent = c.pinned ? '★' : '☆';
      pin.title = 'Pin';
      pin.addEventListener('click', () => {
        state = CORE.togglePin(state, id);
        save().then(render);
      });
      item.appendChild(pin);

      const del = document.createElement('button');
      del.className = 'pin del';
      del.textContent = '✕';
      del.title = 'Remove from library';
      del.addEventListener('click', () => {
        state = CORE.removeChat(state, id);
        save().then(render);
      });
      item.appendChild(del);

      const sel = document.createElement('select');
      sel.className = 'fassign';
      sel.title = 'Folder';
      sel.innerHTML = '<option value="">— folder —</option>' +
        state.folders.map(x => '<option value="' + x.id + '">' + x.name + '</option>').join('');
      sel.value = c.folderId || '';
      sel.addEventListener('click', e => e.stopPropagation());
      sel.addEventListener('change', e => {
        e.stopPropagation();
        state = CORE.setFolder(state, id, e.target.value || null);
        save().then(render);
      });
      item.appendChild(sel);
    }

    updateBulkBar();
  }

  function updateBulkBar() {
    if (!root) return;
    const checked = root.querySelectorAll('.item input[type=checkbox]:checked').length;
    const bulk = root.querySelector('.bulk');
    bulk.classList.toggle('on', checked > 0);
    bulk.querySelector('span').textContent = checked + ' selected';
  }

  function updateBulkBarRef() { updateBulkBar(); }

  function onListChangeRef() { render(); }

  function onFoldersClickRef() { render(); }

  /* re-export small refs used by listeners above */
  function updateBulkBarRef2() { updateBulkBar(); }
  function onFoldersClickRef2() { render(); }
  function onListChangeRef2() { render(); }

  /* ══ Boot ═══════════════════════════════════════════════════════════ */

  function boot() {
    load().then(() => {
      ensureHost();
      captureCurrent();
      render();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
