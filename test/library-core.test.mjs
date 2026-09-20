/**
 * Lumen Library core state tests — runs the shipped library-core.js.
 */
import { readSrc, makeReporter } from './helpers.mjs';
import vm from 'vm';

const ok = makeReporter('library-core');

/* load the shipped classic script */
const sandbox = { console, Date, Math, globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readSrc('src/content/library-core.js'), sandbox, { filename: 'library-core.js' });
const C = sandbox.LumenCore;
ok(Boolean(C), 'LumenCore exposed');

/* ── sanitize ────────────────────────────────────────────────────────── */
ok(C.sanitize(null).chats && C.sanitize(null).folders.length === 0, 'sanitize(null) → empty state');
ok(Object.keys(C.sanitize('junk').chats).length === 0, 'sanitize(junk) → empty state');
const dirty = C.sanitize({
  chats: {
    a: { title: 'ok', folderId: 'f1', tags: ['x', 5, 'y'], pinned: true, added: 7 },
    b: { noTitle: true },
    c: null
  },
  folders: [{ id: 'f1', name: 'F' }, null, { noId: true }, { id: 5, name: 'bad' }]
});
ok(Object.keys(dirty.chats).length === 1 && dirty.chats.a.pinned === true, 'sanitize keeps valid chats only');
ok(JSON.stringify(dirty.chats.a.tags) === '["x","y"]', 'non-string tags dropped');
ok(dirty.folders.length === 1 && dirty.folders[0].name === 'F', 'sanitize keeps valid folders only');

/* ── add/remove chat ─────────────────────────────────────────────────── */
let st = C.empty();
st = C.addChat(st, 'a', 'Alpha');
st = C.addChat(st, 'b', 'Beta');
ok(st.chats.a.title === 'Alpha' && st.chats.a.added > 0, 'addChat stores title + timestamp');
const before = st.chats.a.added;
st = C.addChat(st, 'a', 'Alpha v2');
ok(st.chats.a.title === 'Alpha v2' && st.chats.a.added === before, 'addChat updates title, keeps added');
st = C.removeChat(st, 'b');
ok(!st.chats.b && st.chats.a, 'removeChat deletes only the target');

/* ── rename / folder assign ──────────────────────────────────────────── */
st = C.renameChat(st, 'a', 'Renamed');
ok(st.chats.a.title === 'Renamed', 'renameChat renames');
st = C.addFolder(st, 'Work');
const folderId = st.folderId;
st = st.state;
st = C.setFolder(st, 'a', folderId);
ok(st.chats.a.folderId === folderId, 'setFolder assigns');
st = C.setFolder(st, 'a', null);
ok(st.chats.a.folderId === null, 'setFolder(null) clears');
ok(C.setFolder(st, 'ghost', folderId) === st, 'setFolder on unknown chat is a no-op');

/* ── folders ─────────────────────────────────────────────────────────── */
st = C.addFolder(st, 'Projects');
ok(st.state.folders.length === 2 && st.state.folders[1].name === 'Projects', 'addFolder appends');
const fid2 = st.folderId;
st = st.state;
st = C.setFolder(st, 'a', fid2);
st = C.removeFolder(st, fid2);
ok(!st.folders.some(f => f.id === fid2), 'removeFolder removes the folder');
ok(st.chats.a.folderId === null, 'removeFolder unfiles its chats');

/* ── pin ─────────────────────────────────────────────────────────────── */
st = C.togglePin(st, 'a');
ok(st.chats.a.pinned === true, 'togglePin pins');
st = C.togglePin(st, 'a');
ok(st.chats.a.pinned === false, 'togglePin unpins');
ok(C.togglePin(st, 'ghost') === st, 'togglePin on unknown chat is a no-op');

/* ── tags ────────────────────────────────────────────────────────────── */
st = C.toggleTag(st, 'a', 'code');
st = C.toggleTag(st, 'a', 'sql');
ok(st.chats.a.tags.length === 2, 'toggleTag adds tags');
st = C.toggleTag(st, 'a', 'code');
ok(st.chats.a.tags.length === 1 && st.chats.a.tags[0] === 'sql', 'toggleTag removes existing tag');

/* ── filterChats: query / folder / pinned + ordering ─────────────────── */
let st2 = C.empty();
st2 = C.addChat(st2, 'm1', 'SQL join help');   st2.chats.m1.added = 5;
st2 = C.addChat(st2, 'm2', 'Docker networking'); st2.chats.m2.added = 6; st2 = C.togglePin(st2, 'm2');
st2 = C.addChat(st2, 'm3', 'React re-render');  st2.chats.m3.added = 7;

let ids = C.filterChats(st2, {});
ok(JSON.stringify(ids) === '["m2","m3","m1"]', 'default order: pinned first, then newest');
ids = C.filterChats(st2, { query: 'sql' });
ok(JSON.stringify(ids) === '["m1"]', 'query filters by title (case-insensitive)');
ids = C.filterChats(st2, { pinnedOnly: true });
ok(JSON.stringify(ids) === '["m2"]', 'pinnedOnly filters');
st2 = C.addFolder(st2, 'F'); const fId = st2.folderId; st2 = st2.state;
st2 = C.setFolder(st2, 'm1', fId);
ids = C.filterChats(st2, { folderId: fId });
ok(JSON.stringify(ids) === '["m1"]', 'folder filter works');
ids = C.filterChats(st2, { folderId: fId, query: 'docker' });
ok(ids.length === 0, 'combined filters intersect');

ok.done();
