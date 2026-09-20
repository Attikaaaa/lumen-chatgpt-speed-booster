/**
 * Lumen Library — pure state logic (no DOM).
 * Loaded as a classic script; exposes globalThis.LumenCore.
 *
 * State shape:
 * {
 *   chats:   { [convId]: { title, folderId, tags: string[], pinned, added } },
 *   folders: [ { id, name, color } ]
 * }
 */

(() => {
  'use strict';

  /* Guard against double injection (manifest + programmatic). */
  if (globalThis.LumenCore) return;

  const LumenCore = {};

  /** Empty library state. */
  LumenCore.empty = function empty() {
    return { chats: {}, folders: [] };
  };

  /** Normalizes an unknown stored value into a valid state. */
  LumenCore.sanitize = function sanitize(raw) {
    const state = raw && typeof raw === 'object' ? raw : {};
    const chats = {};
    const folders = [];
    if (state.chats && typeof state.chats === 'object') {
      for (const id of Object.keys(state.chats)) {
        const c = state.chats[id];
        if (c && typeof c === 'object' && typeof c.title === 'string') {
          chats[id] = {
            title: c.title,
            folderId: typeof c.folderId === 'string' ? c.folderId : null,
            tags: Array.isArray(c.tags) ? c.tags.filter(t => typeof t === 'string') : [],
            pinned: c.pinned === true,
            added: Number(c.added) || 0
          };
        }
      }
    }
    if (Array.isArray(state.folders)) {
      for (const f of state.folders) {
        if (f && typeof f.id === 'string' && typeof f.name === 'string') {
          folders.push({ id: f.id, name: f.name, color: typeof f.color === 'string' ? f.color : null });
        }
      }
    }
    return { chats, folders };
  };

  /** Adds or updates a chat entry. Returns a NEW state object. */
  LumenCore.addChat = function addChat(state, convId, title) {
    if (!convId) return state;
    const chats = { ...state.chats };
    const existing = chats[convId];
    chats[convId] = {
      title: title || (existing && existing.title) || '(untitled)',
      folderId: existing ? existing.folderId : null,
      tags: existing ? existing.tags.slice() : [],
      pinned: existing ? existing.pinned : false,
      added: existing ? existing.added : Date.now()
    };
    return { ...state, chats };
  };

  /** Removes a chat entry. */
  LumenCore.removeChat = function removeChat(state, convId) {
    const chats = { ...state.chats };
    delete chats[convId];
    return { ...state, chats };
  };

  /** Renames a chat. */
  LumenCore.renameChat = function renameChat(state, convId, title) {
    if (!state.chats[convId]) return state;
    return { ...state, chats: { ...state.chats, [convId]: { ...state.chats[convId], title } } };
  };

  /** Assigns a chat to a folder (null clears). */
  LumenCore.setFolder = function setFolder(state, convId, folderId) {
    if (!state.chats[convId]) return state;
    return {
      ...state,
      chats: { ...state.chats, [convId]: { ...state.chats[convId], folderId: folderId || null } }
    };
  };

  /** Adds a folder. Returns { state, folderId }. */
  LumenCore.addFolder = function addFolder(state, name, color) {
    const folderId = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const folders = [...state.folders, { id: folderId, name: name || 'New folder', color: color || null }];
    return { state: { ...state, folders }, folderId };
  };

  /** Removes a folder; its chats become unfiled. */
  LumenCore.removeFolder = function removeFolder(state, folderId) {
    const chats = {};
    for (const id of Object.keys(state.chats)) {
      const c = state.chats[id];
      chats[id] = c.folderId === folderId ? { ...c, folderId: null } : c;
    }
    return { ...state, folders: state.folders.filter(f => f.id !== folderId), chats };
  };

  /** Toggles the pinned flag. */
  LumenCore.togglePin = function togglePin(state, convId) {
    if (!state.chats[convId]) return state;
    const c = state.chats[convId];
    return { ...state, chats: { ...state.chats, [convId]: { ...c, pinned: !c.pinned } } };
  };

  /** Adds/removes a tag. */
  LumenCore.toggleTag = function toggleTag(state, convId, tag) {
    if (!state.chats[convId] || !tag) return state;
    const tags = state.chats[convId].tags.slice();
    const i = tags.indexOf(tag);
    if (i >= 0) tags.splice(i, 1); else tags.push(tag);
    return { ...state, chats: { ...state.chats, [convId]: { ...state.chats[convId], tags } } };
  };

  /**
   * Returns conversation ids matching a filter, pinned first, newest first.
   * @param {object} state
   * @param {{query?: string, folderId?: string|null, pinnedOnly?: boolean}} opts
   * @returns {string[]}
   */
  LumenCore.filterChats = function filterChats(state, opts) {
    const query = (opts && opts.query ? opts.query : '').toLowerCase();
    const folderId = opts && opts.folderId !== undefined ? opts.folderId : null;
    const pinnedOnly = !!(opts && opts.pinnedOnly);
    const out = [];
    for (const id of Object.keys(state.chats)) {
      const c = state.chats[id];
      if (query && !(c.title.toLowerCase().includes(query))) continue;
      if (pinnedOnly && !c.pinned) continue;
      if (folderId && c.folderId !== folderId) continue;
      out.push(id);
    }
    out.sort((a, b) => {
      const ca = state.chats[a], cb = state.chats[b];
      const pinDiff = (cb.pinned ? 1 : 0) - (ca.pinned ? 1 : 0);
      if (pinDiff) return pinDiff;
      return (cb.added || 0) - (ca.added || 0);
    });
    return out;
  };

  globalThis.LumenCore = LumenCore;
})();
