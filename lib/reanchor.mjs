/**
 * Reattaching a pin after the HTML file it was left on is edited.
 *
 * A pin remembers a CSS selector. The edit Claude makes is usually the text, the class, or a
 * wrapper around the thing that was pointed at, so that selector misses and the pin would stay
 * lost. Both versions of the file are in hand here: the one the comment was left on, and the one
 * on disk now. Map the old node through that edit.
 *
 * An ambiguous match is a lost pin. Pointing at the sibling that still has the old text is worse
 * than admitting the anchor is gone — see docs/DESIGN.md.
 *
 * No dependency beyond node. The bridge runs from a checkout where nothing has been installed,
 * so this parser is ours rather than parse5's. It follows the HTML5 cases the browser's tree
 * and a pin's chain actually meet: implied html/head/body, implied tbody/tr, a `p` or `li`
 * closed by the next block, void tags, raw text, and self-closing tags left open outside SVG.
 */

import { createHash } from 'node:crypto';

const EXACT_MAX = 1500;
const CONTEXT = 80;
/** Same tag and nothing else still clears this. A different tag never does. */
const FLOOR = 0.4;
/**
 * In a wrapper search, where document order no longer says which copy is which, the winner has
 * to clear the runner-up by this much. A tie is lost.
 */
const MARGIN = 0.05;
/**
 * Where more than one element could be the commented one after an edit, the winner has to lead
 * the runner-up by this much on what the element says - its words, its id - not on the class and
 * slot a newcomer can inherit. See `decisive`.
 */
const CLEAR = 0.2;
/**
 * The similarity alignment is quadratic in the siblings it is given. Unchanged siblings are cut
 * away before it runs, so a local edit leaves a handful; a level that still has more than this
 * after that is a rewrite too large to follow by shape, and the tree match gives the pin up as
 * lost rather than guessing inside it.
 */
const DP_MAX = 250_000;
/**
 * How many insertions and deletions the diff of unchanged siblings looks through before it
 * stops. Past this the siblings are one changed stretch, and DP_MAX decides.
 */
const MAX_EDITS = 400;
/**
 * The bridge answers /reanchor on the same event loop that carries every session's comments, so
 * the tree match has a clock. Past it, the pin is lost for this load - its selector still
 * stands, and the next load asks again. One pin does not get to spend every other pin's time.
 */
const BUDGET_MS = 1500;
const PIN_MS = 400;
/** Thrown out of the tree match when it runs out of time or size. Caught in relocate: lost. */
const GIVE_UP = Symbol('give up');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const HEAD = new Set(['base', 'link', 'meta', 'title', 'style', 'script', 'noscript', 'template']);
const P_CLOSE = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul',
]);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/**
 * A parsed tree is not changed once `parse` returns, so what is derived from a node - its element
 * children, its siblings of the same tag, its fingerprint - is worked out once and kept on it.
 * Recomputing them inside the alignment is what made a long table take minutes.
 */
function elementsOf(node) {
  if (!node) return [];
  if (node._els) return node._els;
  const els = (node.children || []).filter((c) => c.tag !== '#text');
  node._els = els;
  return els;
}

/** The children of `parent` with this tag, in order. Each also learns its own index among them. */
function sameTag(parent, tag) {
  if (!parent) return [];
  let by = parent._byTag;
  if (!by) {
    by = new Map();
    for (const el of elementsOf(parent)) {
      let list = by.get(el.tag);
      if (!list) by.set(el.tag, (list = []));
      el._sib = list.length;
      list.push(el);
    }
    parent._byTag = by;
  }
  return by.get(tag) || [];
}

function indexAmong(same, el) {
  return same[el._sib] === el ? el._sib : same.indexOf(el);
}

export function fileHash(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function decode(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? whole;
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  });
}

const collapse = (s) => decode(s).replace(/\s+/g, ' ').trim();

function attr(el, name) {
  return el.attrs?.find((a) => a.name === name)?.value ?? '';
}

/** Visible text. Script and style are not what a comment was pointing at. */
function textOf(el) {
  if (!el || el.tag === 'script' || el.tag === 'style') return '';
  let out = '';
  for (const c of el.children || []) out += c.tag === '#text' ? c.text : textOf(c);
  return out;
}

/**
 * Up to `limit` characters of raw visible text, and whether that was all of it. A fingerprint
 * reads the first two hundred characters; flattening a whole table to read them is the cost it
 * must not pay for every row it is compared against.
 */
function rawText(el, limit) {
  let out = '';
  const visit = (node) => {
    if (node.tag === 'script' || node.tag === 'style') return true;
    for (const c of node.children || []) {
      if (c.tag === '#text') out += c.text;
      else if (!visit(c)) return false;
      if (out.length >= limit) return false;
    }
    return true;
  };
  const done = !el || visit(el);
  return { text: out, done };
}

/**
 * `collapse(textOf(el)).slice(0, n)`, reading only as much as it needs. A cut through the raw
 * text can only disturb its last few collapsed characters - a half entity, a trailing space -
 * so a read that collapses to comfortably more than `n` has the same first `n`.
 */
function headText(el, n) {
  for (let limit = 4 * n; ; limit *= 4) {
    const { text, done } = rawText(el, limit);
    const out = collapse(text);
    if (done || out.length > n + 16) return out.slice(0, n);
  }
}

function fingerprint(el) {
  if (el._fp) return el._fp;
  const parent = el.parent;
  const same = parent ? sameTag(parent, el.tag) : [el];
  el._fp = {
    tag: el.tag,
    id: attr(el, 'id'),
    testid: attr(el, 'data-testid'),
    classes: attr(el, 'class').split(/\s+/).filter(Boolean),
    text: headText(el, 200),
    childTags: elementsOf(el).map((c) => c.tag),
    parentTag: parent?.tag || '',
    siblingIndex: Math.max(0, indexAmong(same, el)),
    siblingCount: same.length,
  };
  return el._fp;
}

function chainFrom(el) {
  const steps = [];
  for (let node = el; node && node.tag !== 'body' && node.tag !== 'html' && node.tag !== '#document'; node = node.parent) {
    steps.unshift({ tag: node.tag, index: indexAmong(sameTag(node.parent, node.tag), node) });
  }
  return steps;
}

function nodeByChain(body, chain) {
  let node = body;
  for (const step of chain || []) {
    if (!step || typeof step.index !== 'number' || !step.tag) return null;
    node = sameTag(node, step.tag)[step.index];
    if (!node) return null;
  }
  return node === body ? null : node;
}

function walk(node, fn) {
  for (const el of elementsOf(node)) {
    fn(el);
    walk(el, fn);
  }
}

function findAttr(root, name, value) {
  if (!value) return null;
  const hits = [];
  walk(root, (el) => { if (attr(el, name) === value) hits.push(el); });
  return hits.length === 1 ? hits[0] : null;
}

function bodyOf(tree) {
  return elementsOf(tree).find((el) => el.tag === 'html')
    ?.children?.find?.((el) => el.tag === 'body')
    || elementsOf(elementsOf(tree)[0] || {}).find((el) => el.tag === 'body')
    || null;
}

/**
 * The chain a test — or a caller that already parsed — reads back. `spec.fixture` is the
 * `data-fixture` marker the matcher itself never treats as identity.
 */
export function chainOf(html, spec = {}) {
  const body = bodyOf(parse(html));
  if (!body) return null;
  const node = spec.fixture
    ? findAttr(body, 'data-fixture', spec.fixture)
    : spec.id
      ? findAttr(body, 'id', spec.id)
      : spec.testid
        ? findAttr(body, 'data-testid', spec.testid)
        : nodeByChain(body, spec.chain);
  return node ? chainFrom(node) : null;
}

/** Every element of a tree in document order, and the last one to start at each offset. */
function flatten(root) {
  if (root._flat) return root._flat;
  const all = [];
  const at = new Map();
  walk(root, (el) => {
    all.push(el);
    if (typeof el.start === 'number') at.set(el.start, el);
  });
  root._flat = { all, at };
  return root._flat;
}

function elementAt(root, offset) {
  return flatten(root).at.get(offset) || null;
}

/** Deepest element whose source span covers `offset`. */
function elementCovering(root, offset) {
  let best = null;
  for (const el of flatten(root).all) {
    if (typeof el.start !== 'number' || typeof el.end !== 'number') continue;
    if (el.start <= offset && offset < el.end) {
      if (!best || el.end - el.start <= best.end - best.start) best = el;
    }
  }
  return best;
}

// ---------------------------------------------------------------- parser

function isNameChar(c) {
  return /[A-Za-z0-9-]/.test(c || '');
}

/**
 * One pass. Raw-text elements are consumed here, not retokenized: a `<` inside a script is
 * text, and turning it into a tag is how a chain starts pointing at the wrong half of the file.
 */
function tokenize(html) {
  const out = [];
  const n = html.length;
  let i = 0;
  const rawUntil = (from, tag) => {
    const re = new RegExp(`</${tag}\\s*>`, 'ig');
    re.lastIndex = from;
    const m = re.exec(html);
    if (!m) return { textEnd: n, end: n };
    return { textEnd: m.index, end: m.index + m[0].length };
  };

  while (i < n) {
    if (html[i] !== '<') {
      const start = i;
      while (i < n && html[i] !== '<') i++;
      out.push({ type: 'text', start, end: i, text: html.slice(start, i) });
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const start = i;
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      out.push({ type: 'comment', start, end: i });
      continue;
    }
    if (/^<!doctype/i.test(html.slice(i, i + 9))) {
      const start = i;
      const gt = html.indexOf('>', i);
      i = gt < 0 ? n : gt + 1;
      out.push({ type: 'doctype', start, end: i });
      continue;
    }
    if (html.startsWith('<!', i)) {
      const gt = html.indexOf('>', i);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (html[i + 1] === '/') {
      const start = i;
      let j = i + 2;
      const nameStart = j;
      while (j < n && isNameChar(html[j])) j++;
      if (j === nameStart) { i++; out.push({ type: 'text', start: i - 1, end: i, text: '<' }); continue; }
      const tag = html.slice(nameStart, j).toLowerCase();
      const gt = html.indexOf('>', j);
      i = gt < 0 ? n : gt + 1;
      out.push({ type: 'end', tag, start, end: i });
      continue;
    }
    let j = i + 1;
    const nameStart = j;
    while (j < n && isNameChar(html[j])) j++;
    if (j === nameStart || !/[A-Za-z]/.test(html[nameStart])) {
      i++;
      out.push({ type: 'text', start: i - 1, end: i, text: '<' });
      continue;
    }
    const tag = html.slice(nameStart, j).toLowerCase();
    const attrs = [];
    while (j < n) {
      while (j < n && /\s/.test(html[j])) j++;
      if (j >= n || html[j] === '>' || html[j] === '/') break;
      const aStart = j;
      while (j < n && !/[\s=/>]/.test(html[j])) j++;
      if (j === aStart) break;
      const name = html.slice(aStart, j).toLowerCase();
      let value = '';
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        if (html[j] === '"' || html[j] === "'") {
          const q = html[j++];
          const end = html.indexOf(q, j);
          value = end < 0 ? html.slice(j) : html.slice(j, end);
          j = end < 0 ? n : end + 1;
        } else {
          const vStart = j;
          while (j < n && !/[\s>]/.test(html[j])) j++;
          value = html.slice(vStart, j);
        }
      }
      attrs.push({ name, value: decode(value) });
    }
    let selfClosing = false;
    if (html[j] === '/') { selfClosing = true; j++; }
    if (html[j] === '>') j++;
    const tok = { type: 'start', tag, attrs, start: i, end: j, selfClosing };
    i = j;
    if (RAW.has(tag)) {
      const raw = rawUntil(i, tag);
      tok.raw = html.slice(i, raw.textEnd);
      tok.rawEnd = raw.end;
      i = raw.end;
    }
    out.push(tok);
  }
  return out;
}

function elNode(tag, start) {
  return { tag, attrs: [], children: [], parent: null, start, end: null, implied: start == null };
}

function parse(html) {
  const text = String(html);
  const doc = elNode('#document', null);
  const root = elNode('html', null);
  const head = elNode('head', null);
  const body = elNode('body', null);
  root.parent = doc;
  doc.children.push(root);
  head.parent = root;
  root.children.push(head);
  const stack = [root, head];
  let mode = 'head';
  let foreign = 0;

  const top = () => stack[stack.length - 1];
  const pop = (end) => {
    const el = stack.pop();
    if (el && el.end == null) el.end = end;
    if (el && (el.tag === 'svg' || el.tag === 'math') && foreign) foreign--;
    return el;
  };
  const push = (el, parent) => {
    el.parent = parent;
    parent.children.push(el);
    stack.push(el);
    if (el.tag === 'svg' || el.tag === 'math') foreign++;
    return el;
  };
  const open = (tok, parent = top()) => {
    const el = elNode(tok.tag, tok.start);
    el.attrs = tok.attrs || [];
    push(el, parent);
    if (tok.raw != null) {
      if (tok.raw) {
        const textNode = { tag: '#text', text: tok.raw, parent: el };
        el.children.push(textNode);
      }
      el.end = tok.rawEnd;
      stack.pop();
      if (el.tag === 'svg' || el.tag === 'math') foreign--;
    }
    return el;
  };
  const popTag = (tag, end) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag !== tag) continue;
      while (stack.length - 1 >= i) pop(end);
      return true;
    }
    return false;
  };
  /**
   * The nearest open element of `tag`, unless a boundary element sits between it and the top.
   * A nested list's `<li>` must not close the `<li>` outside that list — HTML5 list-item scope.
   */
  const nearest = (tag, boundary) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (boundary?.has(stack[i].tag)) return null;
      if (stack[i].tag === tag) return stack[i];
    }
    return null;
  };
  const ensureBody = (at) => {
    if (mode === 'body') return;
    while (stack.length > 1) pop(at);
    body.parent = root;
    if (!root.children.includes(body)) root.children.push(body);
    stack.push(body);
    mode = 'body';
  };
  const implied = (tag) => {
    const el = elNode(tag, null);
    push(el, top());
    return el;
  };
  const foster = (tag) => {
    const here = top();
    if (tag === 'tr' && here.tag === 'table') implied('tbody');
    if (tag === 'td' || tag === 'th') {
      if (top().tag === 'table') implied('tbody');
      if (top().tag === 'tbody' || top().tag === 'thead' || top().tag === 'tfoot') implied('tr');
    }
  };

  for (const tok of tokenize(text)) {
    if (mode === 'head') {
      if (tok.type === 'doctype' || tok.type === 'comment') continue;
      if (tok.type === 'text' && !tok.text.trim()) continue;
      if (tok.type === 'start' && tok.tag === 'html') { root.start = tok.start; continue; }
      if (tok.type === 'end' && (tok.tag === 'html' || tok.tag === 'head')) {
        if (tok.tag === 'head') head.end = tok.end;
        continue;
      }
      if (tok.type === 'start' && tok.tag === 'head') { head.start = tok.start; continue; }
      if (tok.type === 'start' && tok.tag === 'body') {
        ensureBody(tok.start);
        body.start = tok.start;
        continue;
      }
      if (tok.type === 'start' && HEAD.has(tok.tag)) {
        const el = open(tok, head);
        if (VOID.has(tok.tag)) pop(tok.end);
        else if (tok.raw == null && tok.selfClosing) pop(tok.end);
        if (el.tag === 'script' || el.tag === 'style' || el.tag === 'title') { /* raw already closed */ }
        continue;
      }
      if (tok.type === 'end') continue;
      ensureBody(tok.start ?? tok.end ?? 0);
    }

    if (tok.type === 'comment' || tok.type === 'doctype') continue;
    if (tok.type === 'text') {
      if (!tok.text) continue;
      const parent = top();
      parent.children.push({ tag: '#text', text: tok.text, parent });
      continue;
    }
    if (tok.type === 'end') {
      if (tok.tag === 'body') { popTag('body', tok.end); mode = 'after'; continue; }
      if (tok.tag === 'html') { popTag('html', tok.end); continue; }
      popTag(tok.tag, tok.end);
      continue;
    }
    if (tok.type !== 'start') continue;
    if (tok.tag === 'body') { body.end = null; continue; }
    if (tok.tag === 'html' || tok.tag === 'head') continue;

    if (!foreign) {
      if (P_CLOSE.has(tok.tag) && nearest('p')) popTag('p', tok.start);
      if (tok.tag === 'li' && nearest('li', new Set(['ul', 'ol']))) popTag('li', tok.start);
      const term = tok.tag === 'dt' || tok.tag === 'dd' ? nearest('dt', new Set(['dl'])) || nearest('dd', new Set(['dl'])) : null;
      if (term) popTag(term.tag, tok.start);
      if (tok.tag === 'option' && nearest('option', new Set(['select']))) popTag('option', tok.start);
      if (HEADING.has(tok.tag)) {
        const which = [...stack].reverse().find((el) => HEADING.has(el.tag));
        if (which) popTag(which.tag, tok.start);
      }
      foster(tok.tag);
    }

    open(tok);
    const selfCloses = VOID.has(tok.tag) || (foreign && tok.selfClosing);
    if (selfCloses && tok.raw == null) pop(tok.end);
  }

  while (stack.length) pop(text.length);
  if (body.parent == null) {
    body.parent = root;
    root.children.push(body);
    body.end = text.length;
  }
  return doc;
}

// ---------------------------------------------------------------- identity

function jaccard(a, b) {
  const A = new Set(a || []);
  const B = new Set(b || []);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

function textSim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const longer = Math.max(a.length, b.length);
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / longer;
  return 0;
}

function seqSim(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  let same = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
  return same / n;
}

/**
 * How much two elements are the same node after an edit. Text is a weak term on purpose: the
 * edit is often a change of text, and a strong text term follows the twin that was left alone.
 */
function similarity(a, b) {
  const A = fingerprint(a);
  const B = fingerprint(b);
  if (A.tag !== B.tag) return 0;
  let s = 0.45;
  if (A.id && B.id) s += A.id === B.id ? 0.3 : -0.5;
  if (A.testid && B.testid) s += A.testid === B.testid ? 0.3 : -0.5;
  s += 0.15 * jaccard(A.classes, B.classes);
  s += 0.08 * textSim(A.text, B.text);
  s += 0.1 * seqSim(A.childTags, B.childTags);
  return Math.max(0, s);
}

function tick(ctx) {
  if (Date.now() > ctx.deadline) throw GIVE_UP;
}

/**
 * Order-preserving alignment. On a tie the diagonal wins, so identical siblings stay in order
 * and an insertion before them does not slide the commented one onto the newcomer.
 * A pair of different tags does not match: mapping an h1 onto the div that now wraps it would
 * hide the wrapper case.
 *
 * Only ever given the stretch of siblings the edit actually changed - see `partnerOf`. A stretch
 * still too large to score pair by pair gives up rather than answer from part of it.
 */
function align(oldNodes, newNodes, ctx) {
  const n = oldNodes.length;
  const m = newNodes.length;
  if (n * m > DP_MAX) throw GIVE_UP;
  const GAP = -50;
  const score = (i, j) => {
    const s = similarity(oldNodes[i], newNodes[j]);
    return s > 0 ? Math.round(s * 1000) : -100000;
  };
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const how = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) { dp[i][0] = i * GAP; how[i][0] = 2; }
  for (let j = 1; j <= m; j++) { dp[0][j] = j * GAP; how[0][j] = 3; }
  for (let i = 1; i <= n; i++) {
    if ((i & 31) === 0) tick(ctx);
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + score(i - 1, j - 1);
      const del = dp[i - 1][j] + GAP;
      const ins = dp[i][j - 1] + GAP;
      let best = diag;
      let way = 1;
      if (del > best) { best = del; way = 2; }
      if (ins > best) { best = ins; way = 3; }
      dp[i][j] = best;
      how[i][j] = way;
    }
  }
  const map = new Map();
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const way = how[i][j];
    if (way === 1) { map.set(oldNodes[i - 1], newNodes[j - 1]); i--; j--; }
    else if (way === 2 || (way === 0 && i > 0)) i--;
    else j--;
  }
  return map;
}

/**
 * Two siblings with the same bytes are the same node, left alone by the edit. The key is the
 * source slice, numbered, so the diff below compares integers. An element the parser implied has
 * no bytes of its own and gets a key nothing else shares: it goes to the similarity match like
 * any node that changed.
 */
function keyOf(node, html, ctx) {
  if (node._key !== undefined) return node._key;
  let key;
  if (typeof node.start === 'number' && typeof node.end === 'number' && node.end > node.start) {
    const slice = html.slice(node.start, node.end);
    key = ctx.keys.get(slice);
    if (key === undefined) {
      key = ctx.keys.size;
      ctx.keys.set(slice, key);
    }
  } else {
    // The node itself as the map key: a number no slice and no other implied node will get.
    key = ctx.keys.size;
    ctx.keys.set(node, key);
  }
  node._key = key;
  return key;
}

function keysOf(parent, html, ctx) {
  if (!parent._keys) parent._keys = elementsOf(parent).map((el) => keyOf(el, html, ctx));
  return parent._keys;
}

/**
 * The pairs of equal keys a shortest edit script keeps (Myers), in order, or null when the two
 * lists differ by more than MAX_EDITS insertions and deletions.
 */
function sameRuns(a, a0, a1, b, b0, b1, ctx) {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if ((d & 15) === 0) tick(ctx);
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        const pairs = [];
        for (let e = d; e >= 0; e--) {
          const row = trace[e];
          const at = (kk) => row[kk + e + 1];
          const kNow = x - y;
          const kPrev = kNow === -e || (kNow !== e && at(kNow - 1) < at(kNow + 1)) ? kNow + 1 : kNow - 1;
          const px = at(kPrev);
          const py = px - kPrev;
          while (x > px && y > py) { pairs.push([a0 + x - 1, b0 + y - 1]); x--; y--; }
          x = px;
          y = py;
        }
        return pairs.reverse();
      }
    }
  }
  return null;
}

/**
 * Where `oldNode`, a child of `oldParent`, went among the children of `newParent`. Siblings whose
 * bytes did not change are matched first - the common head and tail, then a diff through the
 * middle - and only the stretch of changed siblings around `oldNode` is scored by shape. An edit
 * to one row of a long table therefore aligns one row, not the table.
 */
function partnerOf(oldParent, newParent, oldNode, ctx) {
  // A different tag never aligns, so with none of this tag here there is nothing to align. This
  // is most of what a wrapper search looks at, and it is answered without a diff.
  if (!sameTag(newParent, oldNode.tag).length) return null;
  const oldKids = elementsOf(oldParent);
  const newKids = elementsOf(newParent);
  const at = oldKids.indexOf(oldNode);
  if (at < 0) return null;
  const a = keysOf(oldParent, ctx.oldHtml, ctx);
  const b = keysOf(newParent, ctx.newHtml, ctx);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  if (at < lo) return newKids[at];
  let endA = a.length;
  let endB = b.length;
  while (endA > lo && endB > lo && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  if (at >= endA) return newKids[at - endA + endB];
  let fromA = lo;
  let fromB = lo;
  let toA = endA;
  let toB = endB;
  for (const [i, j] of sameRuns(a, lo, endA, b, lo, endB, ctx) || []) {
    if (i === at) return newKids[j];
    if (i < at) { fromA = i + 1; fromB = j + 1; } else { toA = i; toB = j; break; }
  }
  // A new sibling with the bytes of some other old sibling is that sibling, moved - an unchanged
  // copy of a different element, whatever the diff paired it with. Left in the stretch, it is a
  // same-tag, same-class candidate that clears FLOOR, and a reorder hands the pin to it. Only a
  // key the commented element itself shares is kept: that copy may be the element, untouched.
  const others = new Set();
  a.forEach((key, i) => { if (i !== at && key !== a[at]) others.add(key); });
  const window = newKids.slice(fromB, toB).filter((el, i) => !others.has(b[fromB + i]));
  const oldWindow = oldKids.slice(fromA, toA);
  return decisive(oldNode, align(oldWindow, window, ctx).get(oldNode) || null, oldWindow, window);
}

/** Lowercased words and numbers, as a set: what two versions of a sentence share. */
function words(text) {
  if (!text) return new Set();
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

/**
 * How much two elements say the same thing, on the evidence an inserted element does not get
 * from its position: shared words (a Dice coefficient over them, so "Two: the commented card"
 * and "Two, reworded after the update" count for something where a substring test says nothing),
 * and an id or testid both carry. Class and slot are left out on purpose - they are exactly what
 * a card inserted where the commented one stood has in common with it.
 */
function evidence(a, b) {
  const A = fingerprint(a);
  const B = fingerprint(b);
  const x = words(A.text);
  const y = words(B.text);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  let s = x.size + y.size ? (2 * shared) / (x.size + y.size) : 0;
  if (A.id && B.id) s += A.id === B.id ? 1 : -1;
  if (A.testid && B.testid) s += A.testid === B.testid ? 1 : -1;
  return s;
}

/** The one of `among` that `evidence` puts clearly ahead of the rest, or null. */
function clearlyBest(score, among) {
  if (among.length === 1) return among[0];
  const ranked = among.map((el) => ({ el, s: score(el) })).sort((p, q) => q.s - p.s);
  return ranked[0].s - ranked[1].s >= CLEAR ? ranked[0].el : null;
}

/**
 * The alignment's answer, unless the changed stretch grew around the target. A same-tag,
 * same-class sibling clears FLOOR on class and slot alone, so an edit that inserts a card where
 * the commented one stood, and rewrites the commented one, offers two candidates for one old
 * element - and the alignment picks the newcomer, which has the old class and the old slot.
 *
 * So when the stretch holds more new elements like the target than old ones - something was
 * inserted among them - the answer is whichever candidate `evidence` puts clearly ahead, and none
 * if no candidate is. Where the counts match, the stretch is the same elements rewritten in place
 * and order is the evidence, as the alignment already weighs it: two adjacent rows both edited
 * stay each on its own row, however alike their words are.
 */
function decisive(target, hit, oldWindow, newWindow) {
  if (!hit) return null;
  const rivals = newWindow.filter((el) => similarity(target, el) >= FLOOR);
  const peers = oldWindow.filter((el) => similarity(target, el) >= FLOOR);
  if (rivals.length <= peers.length) return hit;
  return clearlyBest((el) => evidence(target, el), rivals);
}

function strictlyUnique(target, hit, among) {
  const s = similarity(target, hit);
  if (s < FLOOR) return false;
  for (const other of among) {
    if (other === hit) continue;
    if (s - similarity(target, other) < MARGIN) return false;
  }
  return true;
}

/** The child of `parent` that `target` is, or is inside. Walked up from the target, not down. */
function branchContaining(parent, target) {
  for (let node = target; node; node = node.parent) if (node.parent === parent) return node;
  return null;
}

/**
 * `strict` is the wrapper search: document order is no longer evidence, so a tie is lost.
 * Along a parent that itself aligned, order is the evidence and a tie keeps the diagonal.
 */
function matchUnder(oldParent, newParent, target, strict, depth, ctx) {
  if (!oldParent || !newParent || depth > 6) return null;
  tick(ctx);
  const newKids = elementsOf(newParent);

  if (target.parent === oldParent) {
    const hit = partnerOf(oldParent, newParent, target, ctx);
    if (hit && similarity(target, hit) >= FLOOR && (!strict || strictlyUnique(target, hit, newKids))) {
      return hit;
    }
    if (depth >= 4) return null;
    const found = [];
    for (const child of newKids) {
      const inner = matchUnder(oldParent, child, target, true, depth + 1, ctx);
      if (inner) found.push(inner);
    }
    return found.length === 1 ? found[0] : null;
  }

  const branch = branchContaining(oldParent, target);
  if (!branch) return null;
  const partner = partnerOf(oldParent, newParent, branch, ctx);
  if (partner) {
    const inner = matchUnder(branch, partner, target, strict, depth + 1, ctx);
    if (inner) return inner;
  }
  if (depth >= 4) return null;
  const found = [];
  for (const child of newKids) {
    const inner = matchUnder(oldParent, child, target, true, depth + 1, ctx);
    if (inner) found.push(inner);
  }
  return found.length === 1 ? found[0] : null;
}

function indexesOf(haystack, needle) {
  if (!needle) return [];
  const hits = [];
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    if (hits.length > 1) return hits;
    from = at + Math.max(1, needle.length);
  }
  return hits;
}

function describe(html, node, kind, extra = {}, hash = fileHash(html)) {
  const start = node.start ?? 0;
  const end = node.end ?? start;
  const whole = html.slice(start, end);
  const truncated = whole.length > EXACT_MAX;
  const exact = truncated ? whole.slice(0, EXACT_MAX) : whole;
  return {
    hash,
    kind,
    start,
    end,
    exact,
    truncated: truncated || undefined,
    prefix: html.slice(Math.max(0, start - CONTEXT), start),
    suffix: html.slice(end, end + CONTEXT),
    fingerprint: fingerprint(node),
    ...(extra.quote != null ? { quote: extra.quote } : {}),
  };
}

function locate(html, anchor) {
  const tree = parse(html);
  const body = bodyOf(tree);
  if (!body) return null;
  const byTest = findAttr(body, 'data-testid', anchor.testid);
  if (byTest) return byTest;
  const byId = findAttr(body, 'id', anchor.id);
  if (byId) return byId;
  const chain = anchor.chain || anchor.elements?.[0]?.chain;
  return chain ? nodeByChain(body, chain) : null;
}

const FIELD = new Set(['input', 'textarea', 'select']);

/**
 * Rendered text and source text, made comparable. `innerText` has applied text-transform and
 * decoded every entity, and it lays blocks out with line breaks the source does not have. Only
 * letters and digits are compared, lowercased; an entity this decoder does not know is dropped
 * rather than read as the letters of its name.
 */
function loose(s) {
  return decode(String(s || '')).replace(/&[a-z][a-z0-9]*;/gi, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether the node the file gives for this anchor is the one the user pointed at. The file is
 * read when the comment arrives, and Claude may have written it since the tab loaded: the
 * testid, id or chain from the old DOM can then name a different element in the new bytes. A
 * source recorded against that element would later move the pin onto it, so the anchor's own
 * evidence - its tag, the start of its rendered text - has to agree. A form field's text is its
 * value, which the source does not hold, so for a field only the tag is compared.
 */
function pointedAt(node, anchor, rendered) {
  const chain = Array.isArray(anchor.chain) ? anchor.chain : [];
  const tag = /^[a-z][a-z0-9-]*/i.exec(String(anchor.tag || ''))?.[0] || chain[chain.length - 1]?.tag;
  if (typeof tag === 'string' && tag && tag.toLowerCase() !== node.tag) return false;
  if (FIELD.has(node.tag)) return true;
  const want = loose(rendered).slice(0, 40);
  return !want || loose(textOf(node)).includes(want);
}

/**
 * The source anchor recorded when the comment is sent, or null when the node cannot be found, or
 * when the node the file has there is not the one the user pointed at. Null does not fail the
 * comment: the pin keeps today's selector and nothing else.
 */
export function captureSource(html, anchor = {}) {
  const text = String(html);
  const kind = anchor.kind || 'element';
  if (kind === 'selection') {
    const holder = locate(text, anchor);
    const quote = String(anchor.selectedText || anchor.quote || '');
    if (!quote) return null;
    if (holder && !pointedAt(holder, anchor, quote)) return null;
    const hits = indexesOf(text, quote);
    if (hits.length === 1) {
      const start = hits[0];
      const fake = {
        tag: holder?.tag || 'body',
        attrs: holder?.attrs || [],
        children: holder?.children || [],
        parent: holder?.parent || null,
        start,
        end: start + quote.length,
      };
      // The range describes the quote. The fingerprint describes the element that held it,
      // which is what a rewritten quote falls back to.
      const described = describe(text, { ...fake, parent: holder?.parent, children: holder?.children, attrs: holder?.attrs, tag: holder?.tag }, 'selection', { quote });
      if (holder) described.fingerprint = fingerprint(holder);
      described.start = start;
      described.end = start + quote.length;
      described.exact = quote.length > EXACT_MAX ? quote.slice(0, EXACT_MAX) : quote;
      described.prefix = text.slice(Math.max(0, start - CONTEXT), start);
      described.suffix = text.slice(described.end, described.end + CONTEXT);
      described.holderStart = holder?.start;
      return described;
    }
    if (!holder) return null;
    const described = describe(text, holder, 'selection', { quote });
    described.holderStart = holder.start;
    return described;
  }

  // A region is pinned to the first element it caught, and that element's brief is its evidence.
  const pointed = kind === 'region' ? { ...anchor, ...(anchor.elements?.[0] || {}) } : anchor;
  const node = locate(text, pointed);
  if (!node || node.tag === 'body' || node.tag === 'html') return null;
  if (!pointedAt(node, pointed, pointed.text)) return null;
  return describe(text, node, kind === 'region' ? 'region' : 'element');
}

function resultFor(ctx, node, kind, extra = {}) {
  if (!node) return { lost: true };
  const fp = fingerprint(node);
  return {
    chain: chainFrom(node),
    tag: fp.tag,
    id: fp.id || undefined,
    testid: fp.testid || undefined,
    source: describe(ctx.newHtml, extra.range || node, kind, extra, ctx.hash),
    ...(extra.quoteFound != null ? { quoteFound: extra.quoteFound } : {}),
  };
}

/** prefix + exact + suffix, unique. Context travelled with the element, so this is not a twin. */
function contextNode(newHtml, tree, source) {
  if (source.truncated || !source.exact) return null;
  const needle = `${source.prefix || ''}${source.exact}${source.suffix || ''}`;
  const around = indexesOf(newHtml, needle);
  if (around.length !== 1) return null;
  const start = around[0] + (source.prefix || '').length;
  return elementAt(tree, start) || elementCovering(tree, start);
}

/** The old source slice, unique. A twin check still applies: the slice may be the unedited copy. */
function exactNode(newHtml, tree, source) {
  if (source.truncated || !source.exact) return null;
  const hits = indexesOf(newHtml, source.exact);
  if (hits.length !== 1) return null;
  return elementAt(tree, hits[0]) || elementCovering(tree, hits[0]);
}

/**
 * Moves pins onto one new version of the file. Everything a pin does not change is worked out
 * once for all of them: the new file's hash and tree, each old version's tree, and the numbering
 * of unchanged source slices. Parsing both files again for every pin is how a hundred pins on a
 * large page became a hundred parses of it.
 *
 * `budgetMs` is the whole call's clock, and no one pin's tree match may take more than `pinMs`
 * of it. A pin that runs out is lost for now - see BUDGET_MS.
 */
export function relocator(newHtml, { budgetMs = BUDGET_MS, pinMs = PIN_MS } = {}) {
  const next = String(newHtml);
  const trees = new Map();
  const shared = {
    newHtml: next,
    hash: fileHash(next),
    deadline: Date.now() + budgetMs,
    keys: new Map(),
    treeOf(text) {
      let tree = trees.get(text);
      if (!tree) {
        tree = parse(text);
        trees.set(text, tree);
      }
      return tree;
    },
  };
  return (oldHtml, source) => {
    // Per pin: its own old version and its own slice of the clock. The rest is the same object.
    const ctx = Object.create(shared);
    ctx.oldHtml = oldHtml == null ? null : String(oldHtml);
    ctx.deadline = Math.min(shared.deadline, Date.now() + pinMs);
    return relocateWith(ctx, source);
  };
}

/**
 * Map `source`, captured against `oldHtml`, onto `newHtml`.
 *
 * `oldHtml` may be null when the snapshot of that version is gone. Quote matching still runs.
 * The tree match, which is what follows a rewritten element, does not.
 */
export function relocate(oldHtml, newHtml, source, options) {
  return relocator(newHtml, options)(oldHtml, source);
}

function relocateWith(ctx, source) {
  if (!source || typeof source !== 'object') return { lost: true };
  const next = ctx.newHtml;
  if (source.hash && source.hash === ctx.hash) return { same: true };
  const kind = source.kind || 'element';
  const tree = ctx.treeOf(next);
  const body = bodyOf(tree);
  if (!body) return { lost: true };

  if (kind === 'selection') {
    const quote = source.quote || source.exact || '';
    const hits = indexesOf(next, quote);
    if (hits.length === 1) {
      const holder = elementCovering(tree, hits[0]);
      if (holder && holder.tag !== 'body' && holder.tag !== 'html') {
        return resultFor(ctx, holder, 'selection', { quote, quoteFound: true });
      }
    }
    // The quote itself was rewritten. Fall back to the element that held it — do not invent
    // a new quote for the pin to pretend it still selected.
  }

  // Parsed only when an answer needs it, and then once for every pin on that version.
  const oldTree = () => (ctx.oldHtml != null ? ctx.treeOf(ctx.oldHtml) : null);
  if (kind !== 'selection') {
    const contextual = contextNode(next, tree, source);
    if (contextual && contextual.tag !== 'body' && contextual.tag !== 'html') {
      return resultFor(ctx, contextual, kind);
    }
    const copied = exactNode(next, tree, source);
    if (copied && copied.tag !== 'body' && copied.tag !== 'html') {
      // The slice is once in the new file. If it was also once in the old one, it is the same
      // element, wherever it went. If the old file had it twice, the commented element and a
      // twin were byte for byte alike, and the copy left standing may be the twin that was not
      // edited: that is the tree match's question, not this one's. With no old version to ask,
      // a unique slice is the best evidence there is.
      if (ctx.oldHtml == null || indexesOf(ctx.oldHtml, source.exact).length === 1) {
        return resultFor(ctx, copied, kind);
      }
    }
  }

  const before = oldTree();
  if (!before) return { lost: true };
  const oldBody = bodyOf(before);
  const oldNode = kind === 'selection'
    ? (elementAt(before, source.holderStart) || elementCovering(before, source.holderStart ?? source.start))
    : (elementAt(before, source.start) || elementCovering(before, source.start));
  if (!oldBody || !oldNode || oldNode.tag === 'body') return { lost: true };
  let matched;
  try {
    matched = matchUnder(oldBody, body, oldNode, false, 0, ctx);
  } catch (e) {
    // Out of time or out of size. Whatever was found before that is an answer from part of the
    // evidence, which is a guess; the pin stays lost.
    if (e === GIVE_UP) return { lost: true };
    throw e;
  }
  if (!matched) return { lost: true };
  return resultFor(ctx, matched, kind, kind === 'selection'
    ? { quote: source.quote, quoteFound: false }
    : {});
}
