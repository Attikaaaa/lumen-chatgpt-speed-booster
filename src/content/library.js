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
 *  - Item rows stay clean at rest; pin / move / delete appear on hover.
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
    .hd { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #2a2a2a; }
    .hd b { font-size: 14px; letter-spacing: .01em; }
    .hd .x { background: none; border: 0; color: #8a8a8b; font-size: 15px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
    .hd .x:hover { background: #262626; color: #f2f2f2; }
    .tools { display: flex; gap: 6px; padding: 12px 16px; border-bottom: 1px solid #2a2a2a; }
    .tools input[type=text] {
      flex: 1; min-width: 0; height: 32px; padding: 0 12px; border: 1px solid #3a3a3a;
      border-radius: 9px; background: #1c1c1c; color: #f2f2f2; outline: none; font-size: 12.5px;
    }
    .tools input:focus { border-color: #0091ff; }
    .tools button { white-space: nowrap;
      height: 32px; padding: 0 11px; border: 1px solid #3a3a3a; border-radius: 9px;
      background: #1c1c1c; color: #e6e6e6; cursor: pointer; font-size: 12px;
    }
    .tools button:hover { background: #282828; border-color: #4a4a4a; }
    .folders { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 16px; border-bottom: 1px solid #2a2a2a; }
    .fchip {
      display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px;
      border: 1px solid #3a3a3a; border-radius: 999px; background: transparent;
      color: #d4d4d4; font-size: 11.5px; cursor: pointer;
    }
    .fchip:hover { background: #1f1f1f; }
    .fchip.on { border-color: #0091ff; color: #7fc4ff; background: rgba(0,145,255,.08); }
    .fchip .fdel { color: #6d6d6e; margin-left: 1px; }
    .fchip .fdel:hover { color: #ff6b6b; }
    .list { flex: 1; overflow-y: auto; padding: 10px 12px; }
    .empty { padding: 32px 16px; text-align: center; color: #7a7a7b; font-size: 12px; line-height: 1.7; }
    .item {
      display: flex; align-items: center; gap: 10px; padding: 11px 12px; margin-bottom: 6px;
      border: 1px solid #262626; border-radius: 11px; background: #1a1a1a; cursor: pointer;
    }
    .item:hover { background: #1f1f1f; border-color: #343434; }
    .item input[type=checkbox] { accent-color: #0091ff; opacity: .35; flex: none; cursor: pointer; }
    .item:hover input[type=checkbox], .item input[type=checkbox]:checked { opacity: 1; }
    .item .star { color: #ffc94d; font-size: 11px; flex: none; }
    .item .meta { flex: 1; min-width: 0; }
    .item .t { display: block; font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item .f { display: block; font-size: 11px; color: #8a8a8b; margin-top: 2px; }
    .acts { display: flex; gap: 2px; flex: none; opacity: 0; transition: opacity .1s; }
    .item:hover .acts { opacity: 1; }
    .iconbtn {
      width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: 7px; background: transparent; color: #9b9b9c; cursor: pointer;
      font-size: 12.5px; padding: 0;
    }
    .iconbtn:hover { background: #2c2c2c; color: #efefef; }
    .iconbtn.pinned { color: #ffc94d; }
    .iconbtn.del:hover { background: rgba(255, 90, 90, .13); color: #ff6b6b; }
    .iconbtn svg { width: 14px; height: 14px; fill: currentColor; }
    .bulk {
      display: none; align-items: center; gap: 6px; padding: 10px 16px;
      border-top: 1px solid #2a2a2a; background: #191919;
    }
    .bulk.on { display: flex; }
    .bulk span { flex: 1; font-size: 11.5px; color: #9b9b9c; }
    .bulk button {
      height: 28px; padding: 0 11px; border: 1px solid #3a3a3a; border-radius: 8px;
      background: #1c1c1c; color: #f2f2f2; font-size: 11.5px; cursor: pointer;
    }
    .bulk button:hover { background: #282828; }
    .ft { padding: 10px 16px 12px; border-top: 1px solid #2a2a2a; color: #6f6f70; font-size: 10.5px; }
  `;

  const FOLDER_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';

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

    panel.querySelector('.bmove').addEventListener('click', () => moveItems(checkedIds()));
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
    if (event.target.closest('.move')) {
      event.stopPropagation();
      moveItems([convId]);
      return;
    }
    if (event.target.closest('.del')) {
      state = CORE.removeChat(state, convId);
      save().then(render);
      return;
    }
    /* clicks on the checkbox are handled via its own listeners; any other
       click opens the conversation */
    if (event.target.closest('input[type=checkbox]')) return;
    window.location.href = '/c/' + convId;
  }

  /* ══ Move / bulk ════════════════════════════════════════════════════ */

  /**
   * Moves chats to a folder chosen by name. Empty input unfiles; a new
   * name creates the folder. Cancel leaves everything untouched.
   * @param {string[]} ids
   */
  function moveItems(ids) {
    if (!ids.length) return;
    const names = state.folders.map(f => f.name);
    const input = prompt(
      'Move to folder. Existing: ' + (names.join(', ') || 'none') +
      '. A new name creates the folder. Leave empty to unfile.', '');
    if (input === null) return;
    const name = input.trim();
    let folderId = null;
    if (name) {
      const existing = state.folders.find(f => f.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        folderId = existing.id;
      } else {
        const res = CORE.addFolder(state, name);
        state = res.state;
        folderId = res.folderId;
      }
    }
    for (const id of ids) state = CORE.setFolder(state, id, folderId);
    save().then(render);
  }

  function checkedIds() {
    return [...root.querySelectorAll('.item input[type=checkbox]:checked')]
      .map(cb => cb.dataset.id);
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
        : 'No saved chats yet.\nOpen a conversation and press “+ current”.';
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
      check.title = 'Select';
      check.addEventListener('click', e => e.stopPropagation()); /* don't navigate */
      check.addEventListener('change', updateBulkBar);
      item.appendChild(check);

      if (c.pinned) {
        const star = document.createElement('span');
        star.className = 'star';
        star.textContent = '★';
        star.title = 'Pinned';
        item.appendChild(star);
      }

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
      f.textContent = (folder ? folder.name : 'Unfiled') + (when ? ' · ' + when : '');
      meta.append(t, f);
      item.appendChild(meta);

      const acts = document.createElement('div');
      acts.className = 'acts';

      const pin = document.createElement('button');
      pin.className = 'iconbtn pin' + (c.pinned ? ' pinned' : '');
      pin.textContent = c.pinned ? '★' : '☆';
      pin.title = c.pinned ? 'Unpin' : 'Pin';

      const move = document.createElement('button');
      move.className = 'iconbtn move';
      move.title = 'Move to folder';
      move.innerHTML = FOLDER_ICON;

      const del = document.createElement('button');
      del.className = 'iconbtn del';
      del.textContent = '✕';
      del.title = 'Remove from library';

      acts.append(pin, move, del);
      item.appendChild(acts);

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
