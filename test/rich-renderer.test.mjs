/**
 * Rich ghost renderer security tests: message text is never parsed as
 * HTML, links are URL-validated (http/https only) and no event-handler
 * attribute can ever appear — verified against the REAL shipped renderer.
 */
import { loadContent, makeReporter, makeConv } from './helpers.mjs';

const ok = makeReporter('rich-renderer');
const { renderRichInto } = loadContent();

/* ── tiny DOM double ─────────────────────────────────────────────────── */
class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  set textContent(v) { this._text = String(v); this.children.length = 0; }
  get textContent() {
    return this._text || this.children.map(c => c.textContent).join('');
  }
}
const doc = {
  createElement: tag => new El(tag),
  createTextNode: text => ({ nodeType: 3, textContent: String(text) })
};

function render(text) {
  const root = new El('div');
  renderRichInto(root, text, doc);
  return root;
}

/* flatten the whole tree for assertions */
function walk(node, fn) {
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}
function allNodes(root, pred) {
  const out = [];
  walk(root, n => { if (pred(n)) out.push(n); });
  return out;
}
const allText = root => allNodes(root, n => n.nodeType === 3 || n._text).map(n => n.textContent).join('');
const scriptElems = root => allNodes(root, n => n.nodeType === 1 && n.tagName === 'SCRIPT');
const onAttrs = root => {
  const bad = [];
  walk(root, n => {
    for (const k of Object.keys(n.attrs || {})) {
      if (/^on/i.test(k)) bad.push(k + '=' + n.attrs[k]);
    }
  });
  return bad;
};
const links = root => allNodes(root, n => n.nodeType === 1 && n.tagName === 'A');

/* ── 1. raw HTML must never become an element ────────────────────────── */
{
  const r = render('<script>alert(1)</script>');
  ok(scriptElems(r).length === 0, '<script> tag is never created');
  ok(onAttrs(r).length === 0, '<script> payload adds no on* attributes');
  ok(allText(r).includes('<script>alert(1)</script>'), 'payload stays visible as plain text');
}
{
  const r = render('<img src=x onerror="alert(1)">');
  ok(allNodes(r, n => n.tagName === 'IMG').length === 0, '<img> tag is never created');
  ok(onAttrs(r).length === 0, 'onerror never appears as an attribute');
}

/* ── 2. javascript: / data: URLs are rejected ────────────────────────── */
for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,test)', '[x](vbscript:msgbox)']) {
  const r = render(bad);
  const ls = links(r);
  ok(ls.length === 1, bad + ' → link element created (inert)');
  ok(ls.length === 1 && ls[0].getAttribute('href') === null, bad + ' → NO href attribute');
  ok(onAttrs(r).length === 0, bad + ' → no on* attributes');
}

/* ── 3. attribute-injection through link URLs ────────────────────────── */
{
  const r = render('[x](https://example.com/"onmouseover="alert(1))');
  ok(onAttrs(r).length === 0, 'quote-in-URL adds NO onmouseover attribute');
  const a = links(r)[0];
  /* the markdown regex consumes up to the first ")" — the parser sees
     URL 'https://example.com/"onmouseover="alert(1'; the test compares
     against exactly that normalized href */
  ok(a && a.getAttribute('href') === new URL('https://example.com/"onmouseover="alert(1').href,
    'hostile URL survives only as a validated href value (DOM API, not HTML)');
  ok(a && a.getAttribute('rel') === 'noopener noreferrer' && a.getAttribute('target') === '_blank',
    'safe link carries target/rel hardening');
}

/* ── 4. http/https links are allowed and hardened ────────────────────── */
{
  const r = render('[docs](https://example.com/a?b=1)');
  const a = links(r)[0];
  ok(a && a.getAttribute('href') === 'https://example.com/a?b=1', 'https link gets href');
  ok(a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener noreferrer', 'https link hardened');
  const r2 = render('[local](http://localhost:3000/x)');
  ok(links(r2)[0].getAttribute('href') === 'http://localhost:3000/x', 'http link gets href');
}

/* ── 5. malformed / hostile markdown never throws or injects ─────────── */
for (const hostile of [
  '**[x](http://a',                /* unclosed everything */
  '[**bold**](javascript:x)',      /* script label inside link */
  '[](https://x)',                 /* empty label */
  '[a]((',                        /* broken URL */
  '`<script>`',                    /* inline code with HTML */
  '*em **strong* bold**',          /* interleaved emphasis */
  '```<script>alert(1)</script>```', /* fenced block with HTML */
  '[x](https://ex.com/"onfocus"=1)' /* more quote games */
]) {
  const r = render(hostile);
  ok(onAttrs(r).length === 0 && scriptElems(r).length === 0, 'hostile input safe: ' + JSON.stringify(hostile));
}

/* ── 6. supported markdown still renders correctly ───────────────────── */
{
  const r = render('plain **bold** and *em* and `code`');
  ok(allNodes(r, n => n.tagName === 'STRONG' && n.textContent === 'bold').length === 1, 'bold renders');
  ok(allNodes(r, n => n.tagName === 'EM' && n.textContent === 'em').length === 1, 'italic renders');
  ok(allNodes(r, n => n.tagName === 'CODE' && n.textContent === 'code').length === 1, 'inline code renders');
}
{
  const r = render('```\nconst x = "<script>";\n```');
  const pre = allNodes(r, n => n.tagName === 'PRE')[0];
  ok(pre && pre.children[0].tagName === 'CODE', 'fenced code renders pre>code');
  ok(pre && pre.textContent === 'const x = "<script>";', 'code content preserved verbatim');
  ok(scriptElems(r).length === 0, 'code block never creates elements');
}
{
  const r = render('- one\n- two\n- three');
  const ul = allNodes(r, n => n.tagName === 'UL')[0];
  ok(ul && ul.children.length === 3, 'list renders 3 items');
}
{
  const r = render('line one\nline two');
  ok(allNodes(r, n => n.tagName === 'BR').length === 1, 'soft line break renders <br>');
}

/* ── 7. buildGhostTurn integration (ghost body via renderer) ─────────── */
/* sanity: renderer output for a real-ish message keeps the text intact */
{
  const text = 'Answer **with** formatting:\n\n- point A\n- point B';
  const r = render(text);
  ok(allText(r).includes('Answer with formatting:'), 'paragraph text preserved');
  ok(allText(r).includes('point A') && allText(r).includes('point B'), 'list text preserved');
}

ok.done();
