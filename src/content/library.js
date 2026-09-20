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
 *  - Event handling is fully delegated on the shadow root: render() only
 *    builds DOM, listeners are attached exactly once.
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
  let btnEl = null;

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
    if (!match) return null;
    const convId = match[1];
    const isNew = convId !== lastCaptured;
    if (!isNew) return convId;
    lastCaptured = convId;

    /* Best title source: the chat's own entry in ChatGPT's sidebar.
       Fallbacks: document title, page h1, short id. */
    let title = '';
    const sideLink = document.querySelector('nav a[href*="/c/' + convId + '"]');
    if (sideLink) title = (sideLink.textContent || '').trim();
    if (!title) title = (document.title || '').replace(/\s*[-–|]\s*ChatGPT\s*$/i, '').trim();
    if (!title) {
      const h = document.querySelector('h1');
      title = h ? h.textContent.trim() : '';
    }
    if (!title || /^chatgpt$/i.test(title)) title = 'Conversation ' + convId.slice(0, 8);

    state = CORE.addChat(state, convId, title);
    save().then(render);
    return convId;
  }

  /* ══ Panel UI (shadow DOM) ══════════════════════════════════════════ */

  const CSS = `
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    :host { all: initial; }
    .panel {
      position: fixed; top: 0; right: 0; width: ${PANEL_W}px; height: 100vh;
      background: #141414; color: #f2f2f2; z-index: 2147483000;
      display: none; flex-direction: column;
      border-left: 1px solid #2a2a2a;
      box-shadow: -12px 0 32px rgba(0,0,0,.35);
      font-size: 13px; line-height: 1.45;
    }
    .panel.on { display: flex; }
    .hd { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #2a2a2a; }
    .hd b { font-size: 14px; }
    .hd .x { background: none; border: 0; color: #9b9b9c; font-size: 16px; cursor: pointer; }
    .tools { display: flex; gap: 6px; padding: 10px 14px; border-bottom: 1px solid #2a2a2a; }
    .tools input[type=text] {
      flex: 1; min-width: 0; height: 30px; padding: 0 10px; border: 1px solid #3a3a3a;
      border-radius: 8px; background: #1c1c1c; color: #f2f2f2; outline: none; font-size: 12.5px;
    }
    .tools input:focus { border-color: #0091ff; }
    .tools button { white-space: nowrap;
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
    .fchip:hover { background: #1f1f1f; }
    .fchip.on { border-color: #0091ff; color: #7fc4ff; background: rgba(0,145,255,.08); }
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

  const PANEL_HTML = `
    <div class="hd"><b>Lumen Library</b><button class="x" title="close">✕</button></div>
    <div class="tools">
      <input type="text" placeholder="Search…" aria-label="Search chats" />
      <button class="addcur" title="Save the currently open chat">+ current</button>
      <button class="addf" title="New folder">+ folder</button>
    </div>
    <div class="folders" role="tablist"></div>
    <div class="list"></div>
    <div class="bulk"><span></span><button class="bmove">Move…</button><button class="bdel">Delete</button></div>
    <div class="ft">Folders, pins and tags are stored locally in your browser.</div>
  `;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;';
    root = host.attachShadow({ mode: 'open' });

    /* shadow styles — without these the panel renders unstyled */
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    btnEl = document.createElement('button');
    btnEl.textContent = 'Lumen';
    btnEl.style.cssText = [
      'height:30px;padding:0 12px;border-radius:999px;border:1px solid #3a3a3a;',
      'background:rgba(20,20,20,.92);color:#9b9b9c;font:600 11px/1 system-ui,sans-serif;',
      'letter-spacing:.08em;cursor:pointer'
    ].join(';');
    root.appendChild(btnEl);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = PANEL_HTML;
    root.appendChild(panel);

    document.documentElement.appendChild(host);

    btnEl.addEventListener('click', () => setOpen(true));

    /* ── delegated listeners: attached exactly once ─────────────────── */

    panel.querySelector('.x').addEventListener('click', () => setOpen(false));

    panel.querySelector('.addcur').addEventListener('click', () => {
      const btn = panel.querySelector('.addcur');
      const convId = captureCurrent();
      if (!convId) {
        btn.textContent = 'open a chat first';
        setTimeout(() => { btn.textContent = '+ current'; }, 1500);
        return;
      }
      if (!open) setOpen(true);
      render();
      btn.textContent = '✓ saved';
      setTimeout(() => { btn.textContent = '+ current'; }, 1200);
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

    panel.querySelector('.folders').addEventListener('click', onFoldersClick);
    panel.querySelector('.list').addEventListener('click', onListClick);
    panel.querySelector('.list').addEventListener('change', onListChange);

    panel.querySelector('.bmove').addEventListener('click', () => bulkApply(selectedFolderId()));
    panel.querySelector('.bdel').addEventListener('click', bulkDelete);
  }

  function setOpen(next) {
    open = next;
    ensureHost();
    root.querySelector('.panel').classList.toggle('on', open);
    if (btnEl) btnEl.style.display = open ? 'none' : 'inline-block';
    if (open) { captureCurrent(); render(); }
  }

  /* ══ Delegated handlers ═════════════════════════════════════════════ */

  function onFoldersClick(event) {
    const chip = event.target.closest('.fchip');
    if (!chip) return;

    /* folder delete (✕ inside a folder chip) */
    const del = event.target.closest('.fdel');
    if (del && chip.dataset.folder && chip.dataset.folder !== '__pinned') {
      event.stopPropagation();
      state = CORE.removeFolder(state, chip.dataset.folder);
      if (filter.folderId === chip.dataset.folder) filter.folderId = null;
      save().then(render);
      return;
    }

    const key = chip.dataset.chip;
    if (key === 'all') {
      filter.folderId = null;
      filter.pinnedOnly = false;
      render();
    } else if (key === 'pinned') {
      filter.pinnedOnly = !filter.pinnedOnly;
      if (filter.pinnedOnly) filter.folderId = null;
      render();
    } else if (chip.dataset.folder) {
      filter.pinnedOnly = false;
      filter.folderId = filter.folderId === chip.dataset.folder ? null : chip.dataset.folder;
      render();
    }
  }

  function onListClick(event) {
    const item = event.target.closest('.item');
    if (!item) return;
    const convId = item.dataset.id;

    if (event.target.closest('.pin')) {
      state = CORE.togglePin(state, convId);
      save().then(render);
      return;
    }
    if (event.target.closest('.del')) {
      state = CORE.removeChat(state, convId);
      save().then(render);
      return;
    }
    /* clicks on checkbox/select are handled via change or their own
       stopPropagation; any other click opens the conversation */
    if (event.target.closest('input[type=checkbox]') || event.target.closest('select')) return;
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

  /* ══ Bulk actions ═══════════════════════════════════════════════════ */

  function selectedFolderId() {
    const on = root.querySelector('.fchip.on');
    const id = on && on.dataset.folder;
    return id && id !== '__pinned' ? id : null;
  }

  function checkedIds() {
    return [...root.querySelectorAll('.item input[type=checkbox]:checked')]
      .map(cb => cb.dataset.id);
  }

  function bulkApply(folderId) {
    const ids = checkedIds();
    for (const id of ids) state = CORE.setFolder(state, id, folderId);
    save().then(() => { render(); });
  }

  function bulkDelete() {
    const ids = checkedIds();
    for (const id of ids) state = CORE.removeChat(state, id);
    save().then(() => { render(); });
  }

  /* ══ Render ═════════════════════════════════════════════════════════ */

  function render() {
    if (!root) return;
    const foldersEl = root.querySelector('.folders');
    const list = root.querySelector('.list');

    /* folder chips */
    foldersEl.textContent = '';
    const mk = (label, cls, dataset) => {
      const b = document.createElement('button');
      b.className = 'fchip' + (cls ? ' ' + cls : '');
      for (const [k, v] of Object.entries(dataset)) b.dataset[k] = v;
      b.textContent = label;
      foldersEl.appendChild(b);
      return b;
    };
    const anyFilter = filter.folderId !== null || filter.pinnedOnly;
    mk('All', !anyFilter ? 'on' : '', { chip: 'all' });
    mk('★ Pinned', filter.pinnedOnly ? 'on' : '', { chip: 'pinned', folder: '__pinned' });
    for (const f of state.folders) {
      const b = mk(f.name, filter.folderId === f.id ? 'on' : '', { folder: f.id });
      const del = document.createElement('span');
      del.className = 'fdel';
      del.textContent = '✕';
      del.title = 'Delete folder';
      b.appendChild(del);
    }

    /* chat rows */
    list.textContent = '';
    const visible = CORE.filterChats(state, {
      query: (root.querySelector('input[type=text]').value || ''),
      folderId: filter.folderId,
      pinnedOnly: filter.pinnedOnly
    });

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const hasChats = Object.keys(state.chats).length > 0;
      empty.textContent = hasChats
        ? 'No chats match this filter.'
        : 'No saved chats yet — open a conversation and press “+ current”.';
      list.appendChild(empty);
      return;
    }

    for (const id of visible) {
      const c = state.chats[id];
      const item = document.createElement('div');
      item.className = 'item';
      item.dataset.id = id;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.id = id;
      check.addEventListener('click', e => e.stopPropagation()); /* don't navigate */
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
      const when = c.added
        ? new Date(c.added).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : '';
      f.textContent = (c.pinned ? '★ ' : '') + (folder ? folder.name : 'Unfiled') +
        (when ? ' · ' + when : '') +
        (c.tags.length ? ' · ' + c.tags.join(', ') : '');
      meta.append(t, f);
      item.appendChild(meta);

      const pin = document.createElement('button');
      pin.className = 'pin' + (c.pinned ? ' on' : '');
      pin.textContent = c.pinned ? '★' : '☆';
      pin.title = 'Pin';
      item.appendChild(pin);

      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Remove from library';
      item.appendChild(del);

      const sel = document.createElement('select');
      sel.className = 'fassign';
      sel.title = 'Folder';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '— folder —';
      sel.appendChild(opt0);
      for (const x of state.folders) {
        const o = document.createElement('option');
        o.value = x.id;
        o.textContent = x.name;
        sel.appendChild(o);
      }
      sel.value = c.folderId || '';
      sel.addEventListener('click', e => e.stopPropagation());
      item.appendChild(sel);

      list.appendChild(item);
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
