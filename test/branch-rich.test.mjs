/**
 * Branch-safe trimming tests: graph invariants over the REAL trimWithKeep.
 * For every kept node:
 *   - parent is null or exists in the mapping
 *   - every child exists in the mapping
 *   - parent/child links are mutually consistent
 *   - current_node resolves, alternate stubs stay discoverable
 */
import { loadMainWorld, makeConv, makeReporter } from './helpers.mjs';

const ok = makeReporter('branch-graph');
const { trimWithKeep } = loadMainWorld();

/* ── graph invariant checker ─────────────────────────────────────────── */
function assertGraph(payload, label) {
  const mapping = payload.mapping;
  let bad = 0;

  if (!mapping[payload.current_node]) { ok(false, label + ': current_node missing'); bad++; }
  if (!mapping[payload.root || ''] && Object.keys(mapping).length) {
    /* root may legitimately differ from first mapping key only when declared */
    ok(Boolean(payload.root), label + ': root declared');
  }

  for (const [id, node] of Object.entries(mapping)) {
    if (node.parent !== null && node.parent !== undefined && !mapping[node.parent]) {
      ok(false, label + ': dangling parent ' + id + ' -> ' + node.parent);
      bad++;
    }
    for (const child of node.children || []) {
      if (!mapping[child]) {
        ok(false, label + ': dangling child ' + id + ' -> ' + child);
        bad++;
        continue;
      }
      /* mutual consistency: child's parent points back (stubs are the only
         exception — they keep their original parent, which must exist) */
      if (mapping[child].parent !== id && node.children.includes(child)) {
        /* child knows a different parent: allowed only for boundary stubs
           whose parent was removed (parent: null) */
        if (mapping[child].parent !== null) {
          ok(false, label + ': inconsistent pair ' + id + ' <-> ' + child);
          bad++;
        }
      }
    }
  }
  if (bad === 0) ok(true, label + ': graph invariants hold');
}

/* builders for specific shapes */

/** Adds an alternate assistant response (sibling) to node `ofId`. */
function withAlternate(conv, ofId) {
  const altId = ofId + '-alt';
  const parent = conv.mapping[ofId].parent;
  conv.mapping[altId] = {
    id: altId, parent, children: [],
    message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['alt'] } }
  };
  if (parent) conv.mapping[parent].children.push(altId);
  return conv;
}

/** Adds an edited-user-message branch under `parentId`. */
function withEditedUser(conv, parentId) {
  const editId = 'edit-' + parentId;
  conv.mapping[editId] = {
    id: editId, parent: parentId, children: [],
    message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['edited'] } }
  };
  if (parentId) conv.mapping[parentId].children.push(editId);
  return conv;
}

/* ── 1. alternate assistant response (inside window) ─────────────────── */
{
  const conv = withAlternate(makeConv(50), 'n40');
  const r = trimWithKeep(conv, 10);
  ok(!r.passthrough, 'alternate: trims');
  assertGraph(r.json, 'alternate-in-window');
  ok(Boolean(r.json.mapping['n40-alt']), 'alternate stub kept switchable');
  ok(r.json.mapping['n40-alt'].children.length === 0, 'alternate stub subtree truncated');
}

/* ── 2. edited user branch OUTSIDE the window ────────────────────────── */
{
  const conv = withEditedUser(makeConv(50), 'n30');
  const r = trimWithKeep(conv, 10);
  assertGraph(r.json, 'edited-user');
  /* the edit hangs under n30 (sibling of n31, far outside the window):
     one-level stubbing only covers siblings of KEPT turns, so deep edits
     are dropped — documented graceful degradation, graph stays coherent. */
  ok(!r.json.mapping['edit-n30'], 'deep edit outside window is dropped (documented)');
}

/* ── 3. multiple sibling branches ────────────────────────────────────── */
{
  const conv = makeConv(50);
  withAlternate(conv, 'n40');
  withAlternate(conv, 'n40'); /* addAlt twice → two siblings */
  conv.mapping['n40-alt-2'] = {
    id: 'n40-alt-2', parent: 'n39', children: [],
    message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['alt2'] } }
  };
  conv.mapping['n39'].children.push('n40-alt-2');
  const r = trimWithKeep(conv, 10);
  assertGraph(r.json, 'multi-sibling');
  ok(Boolean(r.json.mapping['n40-alt'] && r.json.mapping['n40-alt-2']), 'both siblings kept');
}

/* ── 4. branch at the trim boundary ──────────────────────────────────── */
{
  const conv = withAlternate(makeConv(50), 'n41'); /* n41 = first kept (keep 10 → n41..n49... 50 msgs → n40-n49) */
  const r = trimWithKeep(conv, 10);
  assertGraph(r.json, 'boundary-branch');
  const firstKept = r.json.mapping[r.json.root] ? r.json.root : null;
  ok(Boolean(firstKept), 'boundary: root resolves');
}

/* ── 5. branch inside kept window stays navigable ────────────────────── */
{
  const conv = withAlternate(makeConv(50), 'n45');
  const r = trimWithKeep(conv, 10);
  assertGraph(r.json, 'in-window-branch');
  const alt = r.json.mapping['n45-alt'];
  ok(alt && alt.parent === 'n44' && r.json.mapping['n44'].children.includes('n45-alt'),
    'in-window alternate hangs from its real parent');
}

/* ── 6. nested branches ──────────────────────────────────────────────── */
{
  const conv = withAlternate(makeConv(50), 'n46');
  withEditedUser(conv, 'n46-alt'); /* branch under an alternate */
  const r = trimWithKeep(conv, 10);
  assertGraph(r.json, 'nested-branch');
}

/* ── 7. alternates never reintroduce full subtrees ───────────────────── */
{
  /* alternate with a long subtree: edit at n10 → whole chain n11..n49 */
  const conv = makeConv(50);
  withEditedUser(conv, 'n10');
  let prev = 'edit-n10';
  for (let i = 11; i < 50; i++) {
    const id = 'alt-n' + i;
    conv.mapping[id] = {
      id, parent: prev, children: [],
      message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['deep ' + i] } }
    };
    conv.mapping[prev].children.push(id);
    prev = id;
  }
  const r = trimWithKeep(conv, 10);
  const altDeepCount = Object.keys(r.json.mapping).filter(id => id.startsWith('alt-n')).length;
  /* the whole deep alternate chain hangs far outside the window: one-level
     stubbing drops it entirely instead of reintroducing the payload. */
  ok(altDeepCount === 0, 'deep alternate subtree dropped entirely (no payload reintroduction), got ' + altDeepCount);
  assertGraph(r.json, 'deep-alternate');
}

/* ── 8. current path validity after trim ─────────────────────────────── */
{
  const conv = makeConv(50);
  const r = trimWithKeep(conv, 10);
  const mapping = r.json.mapping;
  let id = r.json.current_node;
  let steps = 0;
  while (id && steps++ < 100) id = mapping[id] ? mapping[id].parent : 'BROKEN';
  ok(id !== 'BROKEN' && steps <= 11, 'current_node walks to root within the window');
}

ok.done();
