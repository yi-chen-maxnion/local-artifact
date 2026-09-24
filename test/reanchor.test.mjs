/**
 * Reattaching a pin after the HTML it was left on changes.
 *
 * The right node is marked with data-fixture, which the matcher does not read. Every assertion
 * is against that mark. "Some element came back" is not a pass — that is how a pin ends up on
 * the twin that still has the old text.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { captureSource, chainOf, fileHash, relocate, relocator } from '../lib/reanchor.mjs';

const strip = (html) => html.replace(/\sdata-fixture="[^"]*"/g, '');

/** The anchor the overlay would have sent, minus the marker the matcher must not see. */
function anchorFor(html, fixture, extra = {}) {
  const chain = chainOf(html, { fixture });
  assert.ok(chain, `fixture ${fixture} is not in the old file`);
  return { kind: extra.kind || 'element', chain, ...extra, chain };
}

function follow(oldHtml, newHtml, extra = {}) {
  const source = captureSource(strip(oldHtml), anchorFor(oldHtml, 'keep', extra));
  assert.ok(source, 'the commented node was not captured');
  const out = relocate(strip(oldHtml), strip(newHtml), source);
  assert.notEqual(out.lost, true, 'expected the anchor to follow');
  assert.notEqual(out.same, true);
  assert.deepEqual(out.chain, chainOf(newHtml, { fixture: 'keep' }));
  assert.equal(out.source.hash, fileHash(strip(newHtml)));
  return out;
}

function stayLost(oldHtml, newHtml, extra = {}) {
  const source = captureSource(strip(oldHtml), anchorFor(oldHtml, 'keep', extra));
  assert.ok(source, 'the commented node was not captured');
  const out = relocate(strip(oldHtml), strip(newHtml), source);
  assert.deepEqual(out, { lost: true });
}

describe('captureSource', () => {
  test('a chain that is not in the file captures nothing', () => {
    assert.equal(captureSource('<h1>Hi</h1>', { chain: [{ tag: 'h1', index: 3 }] }), null);
  });

  test('an id wins, and the hash is the file the comment was left on', () => {
    const html = '<section><h1 id="t">Hi</h1></section>';
    const source = captureSource(html, { id: 't' });
    assert.equal(source.hash, fileHash(html));
    assert.equal(source.fingerprint.id, 't');
    assert.match(source.exact, /<h1 id="t">Hi<\/h1>/);
    assert.equal(source.truncated, undefined);
  });
});

describe('relocate follows the edited node', () => {
  test('text inside the element rewritten', () => {
    follow('<h1 data-fixture="keep" class="title">Hello</h1>', '<h1 data-fixture="keep" class="title">Welcome</h1>');
  });

  test('class rewritten', () => {
    follow('<h1 data-fixture="keep" class="title">Hello</h1>', '<h1 data-fixture="keep" class="headline">Hello</h1>');
  });

  test('style rewritten', () => {
    follow(
      '<p data-fixture="keep" style="color:red">Hello</p>',
      '<p data-fixture="keep" style="color:blue">Hello</p>',
    );
  });

  test('wrapped in a new parent', () => {
    follow(
      '<section><h1 data-fixture="keep" class="title">Hello</h1></section>',
      '<section><div class="wrap"><h1 data-fixture="keep" class="title">Hello</h1></div></section>',
    );
  });

  test('a same-tag sibling inserted before it', () => {
    follow(
      '<ul><li>a</li><li data-fixture="keep">b</li><li>c</li></ul>',
      '<ul><li>NEW</li><li>a</li><li data-fixture="keep">b</li><li>c</li></ul>',
    );
  });

  test('moved under a different parent, with its surrounding context', () => {
    follow(
      '<main><section><h1 data-fixture="keep">Hello</h1></section></main>',
      '<main><aside><h1 data-fixture="keep">Hello</h1></aside></main>',
    );
  });

  test('whitespace, newlines, and attribute order only', () => {
    follow(
      '<h1 class="title" id="t" data-fixture="keep">Hello</h1>',
      '<h1\n  id="t"\n  data-fixture="keep"\n  class="title">Hello</h1>',
    );
  });

  test('text, class, and a new wrapper in one edit', () => {
    follow(
      '<section><h1 data-fixture="keep" class="title">Hello</h1></section>',
      '<section><div class="wrap"><h1 data-fixture="keep" class="headline">Welcome</h1></div></section>',
    );
  });
});

describe('relocate does not guess', () => {
  test('the element is deleted', () => {
    stayLost('<section><h1 data-fixture="keep">Hello</h1><p>stay</p></section>', '<section><p>stay</p></section>');
  });

  test('the passage is replaced by a different shape, with no context left', () => {
    stayLost('<section><h1 data-fixture="keep">Hello</h1></section>', '<section><img alt="banner"></section>');
  });

  test('two identical cards are rebuilt into copies that cannot be told apart', () => {
    stayLost(
      '<section><article class="card" data-fixture="keep"><h2>Hello</h2></article></section>',
      '<section><div><article class="card"><h2>Hello</h2></article><article class="card" data-fixture="keep"><h2>Hello</h2></article></div></section>',
    );
  });

  test('two candidates score within the margin', () => {
    // Reparented, so order is not evidence. The texts diverged by about the same amount.
    stayLost(
      '<section><article class="card" data-fixture="keep"><h2>Hello there friend</h2></article></section>',
      `<section><div>
        <article class="card"><h2>Hello there</h2></article>
        <article class="card" data-fixture="keep"><h2>Hello friend</h2></article>
      </div></section>`,
    );
  });
});

describe('relocate does not stick to the twin that still has the old text', () => {
  test('two identical cards, only the commented card\'s text changes', () => {
    follow(
      `<section>
        <article class="card"><h2>Hello</h2></article>
        <article class="card" data-fixture="keep"><h2>Hello</h2></article>
      </section>`,
      `<section>
        <article class="card"><h2>Hello</h2></article>
        <article class="card" data-fixture="keep"><h2>Welcome</h2></article>
      </section>`,
    );
  });

  test('three siblings, the commented one is the second, and one is inserted before it', () => {
    follow(
      '<ul><li>one</li><li data-fixture="keep">two</li><li>three</li></ul>',
      '<ul><li>inserted</li><li>one</li><li data-fixture="keep">two</li><li>three</li></ul>',
    );
  });
});

/**
 * Found in a real browser, each a pin that landed on the wrong element or stayed lost when the
 * element was plainly still there.
 */
describe('reorders, moves and deletions', () => {
  const cards = (texts, keep) => `<h1>Twins</h1>${texts.map((t, i) => `<p class="card"${i === keep ? ' data-fixture="keep"' : ''}>${t}</p>`).join('')}`;
  const alpha = 'Alpha: not a twin.';
  const twin = 'Twin card with identical text.';
  const omega = 'Omega: not a twin.';

  test('reordered, and an unchanged sibling slid into the commented twin\'s place, is not it', () => {
    // After: Twin, Alpha, Omega, Twin. Alpha kept its bytes, so it is Alpha, wherever it stands;
    // which twin is which, nothing in the edit says.
    stayLost(cards([alpha, twin, twin, omega], 2), cards([twin, alpha, omega, twin]));
  });

  test('moved to the end, unchanged, the one copy of its bytes in either file', () => {
    follow(
      cards(['One: the first card.', 'Two: the commented card.', 'Three: the third card.'], 1),
      cards(['One: the first card.', 'Three: the third card.', 'Two: the commented card.'], 2),
    );
  });

  test('the first of two twins deleted: the copy left may be either one, so it is lost', () => {
    stayLost(cards([alpha, twin, twin, omega], 2), cards([alpha, twin, omega]));
  });

  /**
   * One edit inserts a card where the commented one stood and rewrites the commented one: new
   * class, new words. The newcomer has the old class and the old slot, which is all the shape
   * match sees. Two candidates, and the words do not clearly pick either - "Two, reworded" shares
   * "two" and "the" with the old text, the newcomer shares "card" - so today it is lost. The
   * reworded card would also be right. The newcomer never is.
   */
  const tagged = (list, keep) => `<h1>Update</h1>${list.map(([cls, t], i) => `<p class="${cls}"${i === keep ? ' data-fixture="keep"' : ''}>${t}</p>`).join('')}`;
  const before = tagged([['card', 'One: the first card.'], ['card', 'Two: the commented card.'], ['card', 'Three: the third card.']], 1);

  test('a card inserted in its place while it was reworded and re-classed: never the newcomer', () => {
    const after = tagged([
      ['card', 'One: the first card.'], ['card', 'NEW: inserted card.'],
      ['tile', 'Two, reworded after the update.'], ['card', 'Three: the third card.'],
    ], 2);
    const source = captureSource(strip(before), anchorFor(before, 'keep'));
    const out = relocate(strip(before), strip(after), source);
    if (out.lost) return;
    assert.notDeepEqual(out.chain, [{ tag: 'p', index: 1 }], 'the pin went to the inserted card');
    assert.deepEqual(out.chain, chainOf(after, { fixture: 'keep' }));
  });

  /**
   * The same insertion, with the commented card only re-classed. Its words are all still there,
   * word for word, and the newcomer shares one of them: that is a clear winner on what the element
   * says, so it follows - to the re-classed card, not the one in its old slot and class.
   */
  test('a card inserted in its place while it was only re-classed: follows the words', () => {
    follow(before, tagged([
      ['card', 'One: the first card.'], ['card', 'NEW: inserted card.'],
      ['tile', 'Two: the commented card.'], ['card', 'Three: the third card.'],
    ], 2));
  });

  /**
   * The counterpart: nothing inserted, two neighbouring rows both edited. Their words are nearly
   * the same, so on words alone neither is a clear winner - but the stretch did not grow, the
   * rows were rewritten where they stood, and order says which is which.
   */
  test('two neighbouring rows edited in one change each stay on their own row', () => {
    const row = (name, status) => ['row', `Row ${name}: status ${status}, owner Ann, due Friday, priority high, team Core`];
    follow(
      tagged([row('one', 'open'), row('two', 'open'), row('three', 'open'), row('four', 'open')], 1),
      tagged([row('one', 'open'), row('two', 'closed'), row('three', 'closed'), row('four', 'open')], 1),
    );
  });

  test('a card inserted in its place while it was reworded, keeping most of its words: follows', () => {
    follow(
      tagged([['card', 'Intro'], ['card', 'Pricing: ten dollars a month for the team plan'], ['card', 'Outro']], 1),
      tagged([
        ['card', 'Intro'], ['card', 'Features: fast and simple'],
        ['tile', 'Pricing: twelve dollars a month for the team plan, billed yearly'], ['card', 'Outro'],
      ], 2),
    );
  });
});

describe('selections and regions', () => {
  test('the quote is still there, only the wrapping tag changed', () => {
    const oldHtml = '<p data-fixture="keep">brave new world</p>';
    const newHtml = '<h2 data-fixture="keep">brave new world</h2>';
    const out = follow(oldHtml, newHtml, { kind: 'selection', selectedText: 'brave new world' });
    assert.equal(out.quoteFound, true);
  });

  test('the quote itself was rewritten, so the pin falls back to the element that held it', () => {
    const oldHtml = '<p id="p" data-fixture="keep">hello world</p>';
    const newHtml = '<p id="p" data-fixture="keep">goodbye</p>';
    const out = follow(oldHtml, newHtml, { kind: 'selection', selectedText: 'hello world' });
    assert.equal(out.quoteFound, false);
    assert.equal(out.tag, 'p');
  });

  test('a region follows its ref element', () => {
    const oldHtml = '<section><article data-fixture="keep" class="card"><h2>Hello</h2></article></section>';
    const newHtml = '<section><div><article data-fixture="keep" class="tile"><h2>Hello</h2></article></div></section>';
    const chain = chainOf(oldHtml, { fixture: 'keep' });
    const source = captureSource(strip(oldHtml), { kind: 'region', elements: [{ chain }] });
    assert.equal(source.kind, 'region');
    const out = relocate(strip(oldHtml), strip(newHtml), source);
    assert.deepEqual(out.chain, chainOf(newHtml, { fixture: 'keep' }));
  });

  test('a region whose ref was deleted is lost', () => {
    const oldHtml = '<section><article data-fixture="keep">Hello</article><p>stay</p></section>';
    const newHtml = '<section><p>stay</p></section>';
    const chain = chainOf(oldHtml, { fixture: 'keep' });
    const source = captureSource(strip(oldHtml), { kind: 'region', elements: [{ chain }] });
    assert.deepEqual(relocate(strip(oldHtml), strip(newHtml), source), { lost: true });
  });
});

describe('the same file is not a move', () => {
  test('an unchanged hash comes back as the same anchor', () => {
    const html = '<h1 data-fixture="keep">Hello</h1>';
    const source = captureSource(strip(html), anchorFor(html, 'keep'));
    assert.deepEqual(relocate(strip(html), strip(html), source), { same: true });
  });
});

/**
 * The chain the overlay builds from the live DOM and the chain this parser builds from the
 * file are the same object. A pin is sent with one and reattached with the other. If they
 * disagree, a comment on a static file captures nothing and the pin never moves.
 */
describe('the parser agrees with the DOM the overlay walks', () => {
  const pages = {
    'a heading': '<h1 id="t">Hi</h1>',
    'nested': '<section id="s"><article class="card"><h2 id="t">Hello</h2></article></section>',
    'a list that was not closed': '<ul><li>a<li id="t">b</ul>',
    'a paragraph closed by a div': '<p>a<div id="t">b</div>',
    'a table, which gains a tbody': '<table><tr><td id="t">a</td><td>b</td></tr></table>',
    'a script stays out of the body chain': '<script>if (a < b) {}</script><p id="t">ok</p>',
    'svg self-closes': '<svg><rect id="t" width="1"/></svg>',
    'a div does not self-close': '<div id="t"/><span>x</span>',
  };

  function domChain(el) {
    const steps = [];
    for (let node = el; node && node !== node.ownerDocument.body && node !== node.ownerDocument.documentElement; node = node.parentElement) {
      const same = [...node.parentElement.children].filter((n) => n.localName === node.localName && n.id !== 'cc-overlay-host');
      steps.unshift({ tag: node.localName, index: same.indexOf(node) });
    }
    return steps;
  }

  for (const [name, html] of Object.entries(pages)) {
    test(name, () => {
      const doc = new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
      const el = doc.getElementById('t');
      assert.ok(el, name);
      assert.deepEqual(chainOf(html, { id: 't' }), domChain(el), name);
    });
  }
});

/**
 * The bridge answers /reanchor on the event loop every session's comments arrive on. A long
 * table once took sixteen seconds for one pin, and three thousand rows did not finish at all.
 * The bounds here are loose on purpose - several times what it takes - so a slow machine does
 * not fail them; what they catch is the matcher going quadratic in the page again.
 */
describe('relocate on a large file', () => {
  /** A report: a heading, then a table. Rows are told apart by their text unless `same` says not. */
  function report(rows, { keep = -1, wrap = false, edit = -1, rewrite = -1, same = false } = {}) {
    let html = `<!doctype html><html><body>${wrap ? '<div class="wrap"><h1>Report</h1></div>' : '<h1>Report</h1>'}`;
    html += '<table class="grid"><thead><tr><th>name</th><th>value</th></tr></thead><tbody>';
    for (let i = 0; i < rows; i++) {
      let text = same ? 'same row' : `row ${i}`;
      if (i === edit) text = `row ${i} edited`;
      if (i === rewrite) text = `row ${i} rewritten by the edit`;
      html += `<tr${i === keep ? ' data-fixture="keep"' : ''}><td>${text}</td><td class="n">${same ? 1 : i * 7}</td></tr>`;
    }
    return `${html}</tbody></table></body></html>`;
  }

  /** `follow`, timed: only the relocate, not the capture or the check. */
  function timedFollow(oldHtml, newHtml, options) {
    const source = captureSource(strip(oldHtml), anchorFor(oldHtml, 'keep'));
    assert.ok(source, 'the commented node was not captured');
    const t0 = performance.now();
    const out = relocate(strip(oldHtml), strip(newHtml), source, options);
    const ms = performance.now() - t0;
    assert.notEqual(out.lost, true, 'expected the anchor to follow');
    assert.deepEqual(out.chain, chainOf(newHtml, { fixture: 'keep' }));
    return ms;
  }

  test('3000 rows: the pinned row rewritten, the heading wrapped, another row edited', () => {
    const ms = timedFollow(
      report(3000, { keep: 1500 }),
      report(3000, { keep: 1500, wrap: true, edit: 10, rewrite: 1500 }),
    );
    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
  });

  test('3000 rows that are all alike, so no context is unique and the tree match does the work', () => {
    const ms = timedFollow(
      report(3000, { keep: 1500, same: true }),
      report(3000, { keep: 1500, same: true, wrap: true, edit: 10, rewrite: 1500 }),
    );
    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
  });

  test('a hundred pins on one large file parse it once, not once a pin', () => {
    const cards = (edited) => {
      let html = `<!doctype html><html><body>${edited ? '<div class="wrap"><h1>Cards</h1></div>' : '<h1>Cards</h1>'}`;
      for (let s = 0; s < 200; s++) {
        html += `<section class="s${s}">`;
        for (let c = 0; c < 25; c++) {
          const pinned = c === 12 && s % 2 === 0;
          const text = edited && pinned ? `card ${s}-${c}, rewritten` : `card ${s}-${c} and a line of body text`;
          html += `<article class="card"${pinned ? ` data-fixture="k${s}"` : ''}><h3>Title ${c}</h3><p>${text}</p></article>`;
        }
        html += '</section>';
      }
      return `${html}</body></html>`;
    };
    const oldHtml = cards(false);
    const newHtml = cards(true);
    const pins = [];
    for (let s = 0; s < 200; s += 2) {
      pins.push({ fixture: `k${s}`, source: captureSource(strip(oldHtml), { chain: chainOf(oldHtml, { fixture: `k${s}` }) }) });
    }
    // The clock is lifted so a slow machine fails on the bound below, not by pins going lost.
    const t0 = performance.now();
    const move = relocator(strip(newHtml), { budgetMs: 60000, pinMs: 60000 });
    const out = pins.map((pin) => move(strip(oldHtml), pin.source));
    const ms = performance.now() - t0;
    out.forEach((result, i) => {
      assert.deepEqual(result.chain, chainOf(newHtml, { fixture: pins[i].fixture }), pins[i].fixture);
    });
    assert.ok(ms < 1500, `took ${Math.round(ms)} ms for ${pins.length} pins over ${newHtml.length} bytes`);
  });

  test('a level too large to align, even after the unchanged rows are set aside, is lost', () => {
    // Every row rewritten: nothing is unchanged, and 700 x 700 is past what the alignment scores.
    const rows = (edited) => {
      let html = '<ul>';
      for (let i = 0; i < 700; i++) {
        html += `<li${i === 350 ? ' data-fixture="keep"' : ''}>${edited ? `item ${i} rewritten` : `item ${i}`}</li>`;
      }
      return `${html}</ul>`;
    };
    const oldHtml = rows(false);
    const source = captureSource(strip(oldHtml), anchorFor(oldHtml, 'keep'));
    const out = relocate(strip(oldHtml), strip(rows(true)), source, { budgetMs: 60000, pinMs: 60000 });
    assert.deepEqual(out, { lost: true });
  });

  test('out of time is lost; the answers that need no tree match are still given', () => {
    const oldHtml = '<section><h1 data-fixture="keep" class="title">Hello</h1><p>stay</p></section>';
    const rewritten = '<section><div class="wrap"><h1 data-fixture="keep" class="headline">Welcome</h1></div><p>stay</p></section>';
    const source = captureSource(strip(oldHtml), anchorFor(oldHtml, 'keep'));
    assert.deepEqual(relocate(strip(oldHtml), strip(rewritten), source, { budgetMs: -1 }), { lost: true });
    // Only a wrapper added: the old slice is still in the file, and finding it takes no clock.
    const wrapped = '<section><div class="wrap"><h1 data-fixture="keep" class="title">Hello</h1></div><p>stay</p></section>';
    const out = relocate(strip(oldHtml), strip(wrapped), source, { budgetMs: -1 });
    assert.deepEqual(out.chain, chainOf(wrapped, { fixture: 'keep' }));
  });
});

/**
 * Claude writes the file while the user is still looking at the version before. The comment
 * arrives with evidence from the tab - a chain, an id, a tag, the text on screen - and the file
 * is read as it is now. Where the file has a different element at that spot, no source is
 * recorded: a source for the wrong element would later move the pin onto it.
 */
describe('captureSource refuses a node the user did not point at', () => {
  const was = '<main><p>one</p><p>two</p><p>three</p></main>';
  const now = '<main><p>zero</p><p>one</p><p>two</p><p>three</p></main>';
  const second = [{ tag: 'main', index: 0 }, { tag: 'p', index: 1 }];

  test('a chain from the old tab names a different paragraph in the new file', () => {
    assert.deepEqual(chainOf(was, { chain: second }), second);
    assert.ok(captureSource(was, { kind: 'element', chain: second, text: 'two' }));
    assert.equal(captureSource(now, { kind: 'element', chain: second, text: 'two' }), null);
  });

  test('an id that moved onto an element of another tag', () => {
    const html = '<main><p id="t">Hello</p></main>';
    assert.equal(captureSource(html, { kind: 'element', id: 't', chain: [{ tag: 'main', index: 0 }, { tag: 'h2', index: 0 }], text: 'Hello' }), null);
  });

  test('a region is checked by the brief of the first element it caught', () => {
    const anchor = { kind: 'region', elements: [{ tag: 'p', chain: second, text: 'two' }] };
    assert.ok(captureSource(was, anchor));
    assert.equal(captureSource(now, anchor), null);
    // The brief names its tag with an id or class after it. Only the tag is compared.
    assert.equal(captureSource(was, { kind: 'region', elements: [{ tag: 'li.item', chain: second }] }), null);
  });

  test('a selection is checked against the element that held it', () => {
    const holder = [{ tag: 'main', index: 0 }, { tag: 'p', index: 2 }];
    assert.ok(captureSource(was, { kind: 'selection', chain: holder, selectedText: 'three' }));
    assert.equal(captureSource(now, { kind: 'selection', chain: holder, selectedText: 'three' }), null);
  });

  test('rendered text is compared loosely: case, spacing, entities and punctuation do not count', () => {
    const html = '<main><h1 class="caps">Hello &amp;\n   welcome&mdash;friend</h1></main>';
    const chain = [{ tag: 'main', index: 0 }, { tag: 'h1', index: 0 }];
    // text-transform: uppercase is what innerText returns, and a dash the decoder does not know.
    assert.ok(captureSource(html, { kind: 'element', chain, text: `HELLO & WELCOME${String.fromCharCode(0x2014)}FRIEND` }));
  });

  test('a form field is compared by tag alone - its text is a value the source does not hold', () => {
    const html = '<form><input id="q" value="first"></form>';
    const chain = [{ tag: 'form', index: 0 }, { tag: 'input', index: 0 }];
    assert.ok(captureSource(html, { kind: 'region', elements: [{ tag: 'input#q', chain, text: 'typed since' }] }));
  });
});
