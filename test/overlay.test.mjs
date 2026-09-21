/**
 * The overlay's anchoring, run against the real extension/overlay.js.
 *
 * Everything here is a function whose failure is silent in production. A selector that matches
 * the wrong element, a quote that cannot be found again, a region that reports the forty
 * descendants of a card - none of them throws, none of them looks wrong on the screen, and all
 * of them come back as "the anchor is not on this page" days later. Clicking around does not
 * find them; this does.
 *
 * The file is loaded, not imported: it is one classic-script IIFE with three loaders, so the
 * only honest test is to execute what the browser executes and take the pure functions it hands
 * out through its `__ccTest` seam. See test/dom.mjs.
 *
 * Caveat worth knowing when reading a failure: jsdom has no layout, so every rect is zero and
 * `innerText` is undefined - the overlay falls back to `textContent`, which is what the text
 * assertions below are written against. Nothing tested here depends on either.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detailLines } from '../lib/format.mjs';
import { allElements, overlayWindow, waitFor } from './dom.mjs';

const page = await overlayWindow();
after(() => page.close());
const { api, setBody, window } = page;
const { brief, cssSelector, describe: describeEl, distinctClass, domPath } = api;
const { elementsInRegion, findQuote, pageKey, selectorStep, unique } = api;

/**
 * The whole contract of a selector, for one element: `querySelectorAll` finds exactly one thing
 * and that thing is this element. Anything else and the pin points confidently at the wrong node.
 */
function findsOnlyItself(doc, el) {
  const sel = cssSelector(el);
  let hits;
  try {
    hits = [...doc.querySelectorAll(sel)];
  } catch (err) {
    return `${sel}  <- invalid selector for ${el.outerHTML.slice(0, 60)}: ${err.message}`;
  }
  if (hits.length !== 1) return `${sel}  <- ${hits.length} matches for ${el.outerHTML.slice(0, 60)}`;
  if (hits[0] !== el) return `${sel}  <- matched a different element first`;
  return null;
}

/** Every element of a page, checked. Returns the failures so one assert names all of them. */
function sweep(html) {
  const doc = setBody(html);
  const els = allElements(doc);
  assert.ok(els.length > 0, 'the fixture has no elements');
  return els.map((el) => findsOnlyItself(doc, el)).filter(Boolean);
}

const repeat = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');

describe('cssSelector: the selector for an element finds that element, and only that element', () => {
  // Each of these is a shape of page that breaks a different assumption about how elements can
  // be named: no hooks at all, hooks that lie (duplicate ids), hooks that are worthless
  // (utility classes on everything), and names that are not valid CSS identifiers.
  const pages = {
    'ids and headings': '<div id="head"><h1 id="t">Hi</h1></div><p id="p">x</p>',

    // A duplicate id is unique-looking and is not unique; the selector has to notice.
    'duplicate ids': '<div id="dup">one</div><div id="dup">two</div><span id="dup">three</span>',

    'test ids, unique and repeated':
      '<ul data-testid="list"><li data-testid="row">a</li><li data-testid="row">b</li></ul>',

    // Layout classes sit on hundreds of elements and name nothing; the fallback has to carry it.
    'utility-class soup':
      `<div class="flex items-center h-16">${repeat(30, (i) => `<div class="flex items-center p-2"><span class="text-sm">item ${i}</span></div>`)}</div>`,

    'css-module hashed classes':
      '<div class="Card_root__a1b2"><div class="Card_body__c3d4"><span class="Card_title__e5f6">t</span></div></div>',

    // Nothing to go on but position: the only thing that separates these is nth-of-type.
    'sibling lists': '<main><section><p>a</p><p>b</p><p>c</p></section><section><p>a</p><p>b</p></section></main>',

    'no hooks at all, deeply nested':
      `${repeat(2, () => '<div><div><div><div><span>deep</span></div></div></div></div>')}`,

    'mixed sibling tags': '<div><span>a</span><b>x</b><span>b</span><b>y</b></div>',

    // The table's implied <tbody> and the row/cell repetition, which nth-of-type has to count.
    'tables': '<table><thead><tr><th>h1</th><th>h2</th></tr></thead>'
      + '<tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',

    // Ids that are not identifiers: a leading digit, a colon, a slash, a dot, a space, a quote.
    'ids that need CSS.escape':
      '<div id="1st">a</div><div id="a:b">b</div><div id="a/b">c</div><div id="a.b">d</div>'
      + '<div id="a b">e</div><div id=\'a"b\'>f</div>',

    // Tailwind's variant and fraction syntax is the everyday source of these.
    'classes that need CSS.escape':
      '<div class="md:w-1/2"><span class="2xl:p-4">x</span><i class="a.b">y</i></div><div class="md:w-1/2">z</div>',

    'test ids that need escaping':
      '<div data-testid="1row">a</div><div data-testid="row 2">b</div>'
      + '<div data-testid="a]b">c</div><div data-testid=\'say "hi"\'>d</div>',

    // The tool's own class prefix, on the page rather than on the tool.
    'page elements carrying cc- classes': '<div class="cc-thing">a</div><div class="cc-thing">b</div>',

    'custom elements': '<my-card><my-row>a</my-row><my-row>b</my-row></my-card><my-card><my-row>c</my-row></my-card>',

    // Two identical components on one page: every step collides until the outermost one.
    'two identical component instances':
      `${repeat(2, () => '<div class="wrap"><ul><li><a>x</a></li><li><a>y</a></li></ul></div>')}`,

    // <a> exists in both namespaces, and lowercase SVG tags are matched the same as HTML ones.
    'lowercase svg': '<div><a href="#">html</a><svg><g><circle cx="1" cy="1" r="1"></circle>'
      + '<circle cx="2" cy="2" r="1"></circle></g><a href="#">svg</a></svg></div>',
  };

  for (const [name, html] of Object.entries(pages)) {
    test(name, () => assert.deepEqual(sweep(html), []));
  }

  // A type selector is only case-insensitive for HTML elements: an element in the SVG namespace
  // is matched case-sensitively, so a lowercased `foreignobject` matches nothing at all. Every
  // camelCase SVG tag - foreignObject, linearGradient, clipPath, textPath, feGaussianBlur - and
  // everything inside one, including the HTML a chart library embeds in a <foreignObject>, was
  // unanchorable unless it happened to carry an id.
  test('svg elements with camelCase tag names', () => {
    assert.deepEqual(sweep(
      '<div><svg><defs><linearGradient><stop offset="0"></stop></linearGradient>'
      + '<linearGradient><stop offset="1"></stop></linearGradient>'
      + '<clipPath><rect></rect></clipPath></defs>'
      + '<foreignObject><div class="label"><span>one</span><span>two</span></div></foreignObject>'
      + '<foreignObject><div class="label"><span>three</span></div></foreignObject></svg></div>',
    ), []);
  });

  test('the minimal svg case: the tag is spelled the way the page spells it', () => {
    const doc = setBody('<div><svg><foreignObject><b>x</b></foreignObject></svg></div>');
    const fo = doc.querySelector('foreignObject');
    // What the page agrees the element is called...
    assert.equal(fo.localName, 'foreignObject');
    assert.equal(doc.querySelectorAll('foreignObject').length, 1);
    assert.equal(doc.querySelectorAll('foreignobject').length, 0);
    // ...is what the overlay writes down. Lowercased, this step matched zero elements, and the
    // pin saved against it simply never came back.
    assert.equal(selectorStep(fo), 'foreignObject');
    assert.deepEqual([...doc.querySelectorAll(cssSelector(fo))], [fo]);
    // The camelCase step is a step in the path of what is inside it, too.
    assert.equal(domPath(fo.querySelector('b')), 'div > svg > foreignObject > b');
  });

  test('the page itself is never an anchor, and never a step in a path', () => {
    const doc = setBody('<p id="x">t</p>');
    assert.equal(cssSelector(doc.body), '');
    assert.equal(cssSelector(doc.documentElement), '');
    assert.equal(cssSelector(null), '');
    assert.equal(cssSelector(doc.createTextNode('t')), '');
  });

  test('it stops as soon as it is unique rather than at a fixed depth', () => {
    const doc = setBody('<main id="app"><section><b>deep</b></section></main>');
    // `b` alone already names one element, so nothing above it is written down.
    assert.equal(cssSelector(doc.querySelector('b')), 'b');
    assert.equal(doc.querySelectorAll('b')[0], doc.querySelector('b'));
  });

  test('when nothing is unique on the way up, the path is rooted at body', () => {
    const doc = setBody('<section><div><span>x</span></div></section><div><span>y</span></div><div><span>z</span></div>');
    const y = doc.querySelectorAll('div > span')[1];
    assert.equal(cssSelector(y), 'body > div:nth-of-type(1) > span');
    assert.deepEqual([...doc.querySelectorAll(cssSelector(y))], [y]);
  });
});

describe('selectorStep: one step is an id, a test id, or tag plus what narrows it down', () => {
  test('a unique id wins outright, escaped', () => {
    const doc = setBody('<div id="a:b" class="Card_x1" data-testid="t">x</div>');
    assert.equal(selectorStep(doc.getElementById('a:b')), '#a\\:b');
  });

  test('a repeated id is not a name, so it falls through to the tag', () => {
    const doc = setBody('<div id="dup">a</div><div id="dup">b</div>');
    assert.equal(selectorStep(doc.querySelectorAll('[id=dup]')[1]), 'div:nth-of-type(2)');
  });

  test('a unique data-testid is the next best name', () => {
    const doc = setBody('<div data-testid="save me">x</div>');
    assert.equal(selectorStep(doc.querySelector('div')), '[data-testid="save\\ me"]');
  });

  test('a repeated data-testid falls through too', () => {
    const doc = setBody('<ul><li data-testid="row">a</li><li data-testid="row">b</li></ul>');
    assert.equal(selectorStep(doc.querySelector('li')), 'li:nth-of-type(1)');
  });

  test('at most two classes, and only ones that narrow anything down', () => {
    const doc = setBody(
      `<div>${repeat(20, () => '<span class="flex items-center">u</span>')}`
      + '<span class="flex items-center Card_root__a1 Card_alt__b2 Card_third__c3">x</span></div>',
    );
    const el = doc.querySelector('.Card_root__a1');
    // `flex` and `items-center` are on 21 elements each and say nothing; the three hashed
    // component classes each name one - and the step takes the first two of them, not five.
    // The position is still written down: one step never asks whether it is enough on its own.
    assert.equal(selectorStep(el), 'span.Card_root__a1.Card_alt__b2:nth-of-type(21)');
  });

  test('the tool never names itself with the page: cc- classes are not part of a selector', () => {
    const doc = setBody('<div class="cc-thing card_only__z9">x</div>');
    assert.equal(selectorStep(doc.querySelector('div')), 'div.card_only__z9');
  });

  test('nth-of-type appears only when the tag has more than one sibling of its kind', () => {
    const doc = setBody('<div><p>a</p><span>b</span></div><div><p>a</p><p>b</p></div>');
    const [first, second] = doc.querySelectorAll('div');
    assert.equal(selectorStep(first.querySelector('p')), 'p'); // alone among its siblings
    assert.equal(selectorStep(second.querySelectorAll('p')[1]), 'p:nth-of-type(2)');
  });

  test('nth-of-type counts only siblings of the same tag', () => {
    const doc = setBody('<div><b>1</b><i>x</i><b>2</b><i>y</i><b>3</b></div>');
    assert.equal(selectorStep(doc.querySelectorAll('b')[2]), 'b:nth-of-type(3)');
    assert.equal(selectorStep(doc.querySelectorAll('i')[1]), 'i:nth-of-type(2)');
  });
});

describe('distinctClass: a class earns its place only if it narrows anything down', () => {
  test('twelve uses is still a name; thirteen is layout', () => {
    setBody(`<ul>${repeat(12, (i) => `<li class="row twelve">i${i}</li>`)}</ul>`);
    assert.equal(distinctClass('twelve'), true);
    setBody(`<ul>${repeat(13, (i) => `<li class="row thirteen">i${i}</li>`)}</ul>`);
    assert.equal(distinctClass('thirteen'), false);
  });

  test('a name nobody could have typed is not a name', () => {
    setBody('<div class="' + 'a'.repeat(29) + ' ' + 'b'.repeat(30) + '">x</div>');
    assert.equal(distinctClass('a'.repeat(29)), true);
    assert.equal(distinctClass('b'.repeat(30)), false);
  });

  test('a class that is on nothing is not worth asking about either way', () => {
    setBody('<div>x</div>');
    assert.equal(distinctClass('absent'), true); // 0 <= 12; the caller only ever asks about its own
  });
});

describe('unique: the question the whole selector is built around', () => {
  test('exactly one, and nothing else, counts as unique', () => {
    setBody('<div id="one">a</div><p class="two">b</p><p class="two">c</p>');
    assert.equal(unique('#one'), true);
    assert.equal(unique('.two'), false); // two of them
    assert.equal(unique('#nothing'), false); // none of them
  });

  test('a selector the browser refuses is not unique, it is unusable', () => {
    setBody('<div id="1st">a</div>');
    // Unescaped, this is a syntax error rather than a miss - and must not escape as a throw.
    assert.equal(unique('#1st'), false);
    assert.equal(unique('#\\31 st'), true);
  });
});

describe('domPath: the human-readable trail, capped so it stays readable', () => {
  test('tag, id or first distinct class, per level', () => {
    const doc = setBody('<main id="app"><section class="Card_root__x1 flex"><button>Save</button></section></main>');
    assert.equal(domPath(doc.querySelector('button')), 'main#app > section.Card_root__x1 > button');
  });

  test('an id wins over a class on the same element', () => {
    const doc = setBody('<div id="wrap" class="Card_root__x1"><b>x</b></div>');
    assert.equal(domPath(doc.querySelector('b')), 'div#wrap > b');
  });

  test('never body or html, and never more than eight levels', () => {
    const doc = setBody('<div>'.repeat(12) + '<span id="deep">d</span>' + '</div>'.repeat(12));
    const path = domPath(doc.getElementById('deep'));
    assert.equal(path.split(' > ').length, 8);
    assert.ok(path.endsWith('span#deep'));
    assert.doesNotMatch(path, /body|html/);
  });
});

describe('describe: the anchor a comment is filed against', () => {
  const FIXTURE = '<main id="app"><section class="Card_root__x1">'
    + '<button data-testid="save" role="button" aria-label="Save it">Save   now\n  please</button>'
    + '</section></main>';

  test('every field lib/format.mjs prints is filled in, and spelled the way it reads it', () => {
    const doc = setBody(FIXTURE);
    const a = describeEl(doc.querySelector('button'));
    assert.equal(a.kind, 'element');
    assert.equal(a.selector, '[data-testid="save"]');
    assert.equal(a.path, 'main#app > section.Card_root__x1 > button');
    assert.equal(a.testid, 'save');
    assert.equal(a.role, 'button');
    assert.equal(a.label, 'Save it');
    assert.equal(a.text, 'Save now please'); // runs of whitespace collapsed to one space
    assert.equal(a.html, doc.querySelector('button').outerHTML);
    assert.deepEqual(Object.keys(a.rect), ['x', 'y', 'w', 'h']);
    assert.deepEqual(Object.keys(a.styles), ['color', 'background', 'font', 'display']);
  });

  // The real agreement test: format.mjs is the only reader of this object, so run it.
  test('lib/format.mjs renders it without a single (undefined) or missing line', () => {
    const doc = setBody(FIXTURE);
    const out = detailLines({
      page: { url: 'http://localhost:5173/a' },
      anchor: describeEl(doc.querySelector('button')),
    }).join('\n');
    assert.match(out, /^anchor {2}element {1}<button data-testid="save"/m);
    assert.match(out, /^ {8}selector {2}\[data-testid="save"\]$/m);
    assert.match(out, /^ {8}path {6}main#app > section\.Card_root__x1 > button$/m);
    assert.match(out, /^ {8}testid {4}save$/m);
    assert.match(out, /^ {8}role {6}button {2}label="Save it"$/m);
    assert.match(out, /^ {8}text {6}"Save now please"$/m);
    assert.match(out, /^ {8}rect {6}x=\d+ y=\d+ w=\d+ h=\d+$/m);
    assert.match(out, /^ {8}styles {4}color:/m);
    assert.doesNotMatch(out, /undefined|\[object/);
  });

  test('a label falls back to title, and a testid to data-test-id', () => {
    const doc = setBody('<div id="z" data-test-id="alt" title="tip">q</div>');
    const a = describeEl(doc.getElementById('z'));
    assert.equal(a.testid, 'alt');
    assert.equal(a.label, 'tip');
  });

  test('absent attributes are absent, not empty strings - format.mjs skips on falsiness', () => {
    const doc = setBody('<div id="plain"></div>');
    const a = describeEl(doc.getElementById('plain'));
    for (const k of ['testid', 'role', 'label', 'text']) assert.equal(a[k], undefined, k);
  });

  test('text is cut at 200 characters', () => {
    const doc = setBody(`<p id="long">${'ab '.repeat(200)}</p>`);
    assert.equal(describeEl(doc.getElementById('long')).text.length, 200);
  });

  // The point of the cut is that a big container gives the model its own tag rather than half
  // the page; the element's own text survives whenever it fits.
  test('html is the real outerHTML up to 600 characters, then the open tag alone', () => {
    const fits = setBody(`<div id="m">${'x'.repeat(560)}</div>`).getElementById('m');
    assert.equal(describeEl(fits).html, fits.outerHTML);
    assert.ok(fits.outerHTML.length <= 600);

    const over = setBody(`<div id="m" class="card">${'x'.repeat(700)}</div>`).getElementById('m');
    const html = describeEl(over).html;
    assert.ok(over.outerHTML.length > 600);
    assert.equal(html, '<div id="m" class="card"></div> <!-- truncated -->');
  });
});

describe('brief: the one line each element inside a region gets', () => {
  test('the fields format.mjs prints for a region entry', () => {
    const doc = setBody('<div id="card" class="Card_root__x1" data-testid="card">Hello there</div>');
    const b = brief(doc.getElementById('card'));
    assert.equal(b.tag, 'div#card'); // id wins over class
    assert.equal(b.testid, 'card');
    assert.equal(b.selector, '#card');
    assert.equal(b.text, 'Hello there');
    assert.equal(b.placeholder, undefined);
    assert.deepEqual(Object.keys(b.rect), ['x', 'y', 'w', 'h']);
  });

  test('without an id it is tagged with its first distinct class', () => {
    const doc = setBody('<div class="flex Card_root__x1">x</div>' + repeat(20, () => '<i class="flex">u</i>'));
    assert.equal(brief(doc.querySelector('div')).tag, 'div.Card_root__x1');
  });

  // An input's content is its value; innerText on one is empty, so the region would list a
  // filled-in field as if it were blank.
  test('a field reports its value and its placeholder', () => {
    const doc = setBody('<input id="i" value="typed" placeholder="ph"><textarea id="t">wrote</textarea>');
    assert.equal(brief(doc.getElementById('i')).text, 'typed');
    assert.equal(brief(doc.getElementById('i')).placeholder, 'ph');
    assert.equal(brief(doc.getElementById('t')).text, 'wrote');
  });

  // format.mjs prints the tag and then the selector under it, skipping the second line when they
  // are the same string - which they only are if both spell the tag the way the page does.
  test('an svg element is tagged as the page spells it, like its selector', () => {
    const doc = setBody('<svg><foreignObject><b>x</b></foreignObject></svg>');
    const b = brief(doc.querySelector('foreignObject'));
    assert.equal(b.tag, 'foreignObject');
    assert.equal(b.selector, 'foreignObject');
  });

  test('text is cut at 80 characters, not 200', () => {
    const doc = setBody(`<p id="long">${'ab '.repeat(200)}</p>`);
    assert.equal(brief(doc.getElementById('long')).text.length, 80);
  });

  test('lib/format.mjs lists it under the region without a stray line', () => {
    const doc = setBody('<div id="card" data-testid="card">Hello</div><input id="i" placeholder="ph">');
    const out = detailLines({
      page: {},
      anchor: {
        kind: 'region',
        rect: { x: 0, y: 0, w: 10, h: 10 },
        elements: [brief(doc.getElementById('card')), brief(doc.getElementById('i'))],
      },
    }).join('\n');
    assert.match(out, /^ {10}- div#card {2}\[card] {2}"Hello"$/m);
    assert.match(out, /^ {12}#card$/m);
    assert.match(out, /^ {10}- input#i {2}placeholder="ph"$/m);
    assert.doesNotMatch(out, /undefined/);
  });
});

describe('elementsInRegion: what a drag caught, outermost only', () => {
  const box = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });
  const REGION = { x: 0, y: 0, w: 100, h: 100 };
  const ids = (list) => list.map((n) => n.id);

  test('a card reports as one entry, not as its descendants', () => {
    const doc = setBody('<div id="card"><h2 id="t">T</h2><p id="p">body</p></div><div id="out">o</div>');
    const hits = elementsInRegion(REGION, [
      { node: doc.getElementById('card'), r: box(10, 10, 50, 50) },
      { node: doc.getElementById('t'), r: box(12, 12, 20, 10) },
      { node: doc.getElementById('p'), r: box(12, 25, 20, 10) },
      { node: doc.getElementById('out'), r: box(200, 200, 10, 10) }, // not in the box at all
    ]);
    assert.deepEqual(ids(hits), ['card']);
  });

  test('a child whose parent was not caught is itself outermost', () => {
    const doc = setBody('<div id="card"><h2 id="t">T</h2></div>');
    const hits = elementsInRegion(REGION, [
      { node: doc.getElementById('card'), r: box(10, 10, 300, 300) }, // sticks out of the box
      { node: doc.getElementById('t'), r: box(12, 12, 20, 10) },
    ]);
    assert.deepEqual(ids(hits), ['t']);
  });

  test('only what is fully inside, with two pixels of slack for a rounding error', () => {
    const doc = setBody('<div id="a">a</div><div id="b">b</div><div id="c">c</div><div id="d">d</div>');
    const hits = elementsInRegion(REGION, [
      { node: doc.getElementById('a'), r: box(-2, -2, 10, 10) }, // exactly the tolerance
      { node: doc.getElementById('b'), r: box(-3, 0, 10, 10) }, // one pixel past it
      { node: doc.getElementById('c'), r: box(95, 95, 7, 7) }, // right/bottom land on 102
      { node: doc.getElementById('d'), r: box(95, 95, 8, 8) }, // ...and on 103
    ]);
    assert.deepEqual(ids(hits), ['a', 'c']);
  });

  test('what cannot be seen is not an anchor', () => {
    const doc = setBody('<div id="v">v</div><div id="hid" style="visibility:hidden">h</div>'
      + '<div id="clear" style="opacity:0">o</div><div id="faint" style="opacity:0.5">f</div>');
    const at = (id, y) => ({ node: doc.getElementById(id), r: box(5, y, 10, 10) });
    const hits = elementsInRegion(REGION, [at('v', 0), at('hid', 20), at('clear', 40), at('faint', 60)]);
    assert.deepEqual(ids(hits), ['v', 'faint']); // half-transparent is still something to point at
  });

  test('the limit is the last thing applied, after the outermost reduction', () => {
    const doc = setBody(repeat(20, (i) => `<div id="r${i}">${i}</div>`));
    const all = Array.from({ length: 20 }, (_, i) => ({ node: doc.getElementById(`r${i}`), r: box(1, i * 4, 3, 3) }));
    assert.equal(elementsInRegion(REGION, all).length, 12); // REGION_MAX_ELEMENTS
    assert.equal(elementsInRegion(REGION, all, 3).length, 3);
  });

  // The regression from eeed5d0: `truncated` used to be judged on the capped list, so a region
  // holding exactly twelve always claimed there were more. The fix asks for thirteen and compares,
  // which only works if asking for thirteen returns thirteen when they exist and twelve when they
  // do not - the caller's `all.length > 12` is nothing but this.
  test('asking for one more than is listed is how "there are more" is answered', () => {
    const doc = setBody(repeat(13, (i) => `<div id="r${i}">${i}</div>`));
    const cand = (n) => Array.from({ length: n }, (_, i) => ({ node: doc.getElementById(`r${i}`), r: box(1, i * 4, 3, 3) }));
    assert.equal(elementsInRegion(REGION, cand(12), 13).length, 12); // exactly twelve: not truncated
    assert.equal(elementsInRegion(REGION, cand(13), 13).length, 13); // thirteen: truncated
  });

  test('nothing selectable inside is an empty list, which is what makes a canvas fall back', () => {
    setBody('<canvas id="c"></canvas>');
    assert.deepEqual(elementsInRegion(REGION, []), []);
  });

  // `opacity` does not inherit, so a child of an `opacity:0` container computes to 1. Filtering
  // the container out also stops it shadowing its children in the outermost reduction, so the
  // children were promoted and the region reported a closed dropdown as if it were on the screen.
  // `visibility:hidden` does inherit and never had this problem.
  test('a region over a transparent card reports nothing from inside it', () => {
    const doc = setBody('<div id="ghost" style="opacity:0"><span id="kid">kid</span></div>');
    const hits = elementsInRegion(REGION, [
      { node: doc.getElementById('ghost'), r: box(1, 1, 10, 10) },
      { node: doc.getElementById('kid'), r: box(2, 2, 8, 8) },
    ]);
    assert.deepEqual(ids(hits), []);
  });

  // The transparent container is usually inside the box too, but it does not have to be: a
  // faded-out toast wrapper can be wider than the drag, or not a candidate at all.
  test('the transparent ancestor does not have to be one of the hits', () => {
    const doc = setBody('<div id="ghost" style="opacity:0"><div id="mid"><span id="kid">kid</span></div></div>');
    const hits = elementsInRegion(REGION, [
      { node: doc.getElementById('ghost'), r: box(-50, -50, 400, 400) }, // sticks out of the box
      { node: doc.getElementById('kid'), r: box(2, 2, 8, 8) }, // #mid is not even a candidate
    ]);
    assert.deepEqual(ids(hits), []);
  });

  test('half-transparent is still something to point at, for the children too', () => {
    const doc = setBody('<div id="faint" style="opacity:0.5"><span id="kid">kid</span></div>'
      + '<div id="nearly" style="opacity:0.001"><span id="kid2">kid2</span></div>');
    const hits = elementsInRegion(REGION, [
      { node: doc.getElementById('faint'), r: box(-50, -50, 400, 400) }, // outside, so #kid stands alone
      { node: doc.getElementById('kid'), r: box(2, 2, 8, 8) },
      { node: doc.getElementById('nearly'), r: box(20, 20, 400, 400) },
      { node: doc.getElementById('kid2'), r: box(22, 22, 8, 8) },
    ]);
    assert.deepEqual(ids(hits), ['kid', 'kid2']);
  });

  // `visibility` is the one that inherits - and the one a child can turn back on. That child is
  // genuinely on the screen, so it is genuinely an anchor.
  test('a visible child of a hidden parent is visible', () => {
    const doc = setBody('<div id="hid" style="visibility:hidden">'
      + '<span id="shown" style="visibility:visible">here</span></div>');
    const hits = elementsInRegion(REGION, [
      { node: doc.getElementById('hid'), r: box(1, 1, 20, 20) },
      { node: doc.getElementById('shown'), r: box(2, 2, 8, 8) },
    ]);
    assert.deepEqual(ids(hits), ['shown']);
  });

  // The ancestor walk is memoised per call; the cache must not leak an answer from one call into
  // the next, because the page can change opacity between two mousemoves of the same drag.
  test('a container that stops being transparent is measured again', () => {
    const doc = setBody('<div id="ghost" style="opacity:0"><span id="kid">kid</span></div>');
    const cand = [
      { node: doc.getElementById('ghost'), r: box(-50, -50, 400, 400) },
      { node: doc.getElementById('kid'), r: box(2, 2, 8, 8) },
    ];
    assert.deepEqual(ids(elementsInRegion(REGION, cand)), []);
    doc.getElementById('ghost').style.opacity = '1';
    assert.deepEqual(ids(elementsInRegion(REGION, cand)), ['kid']);
  });
});

describe('findQuote: the quoted text, found again across node boundaries', () => {
  test('a quote spanning several inline elements becomes one range', () => {
    const doc = setBody('<p id="q">Hello <b>brave</b> new <i>world</i> today</p>');
    const r = findQuote(doc.getElementById('q'), 'brave new world');
    assert.equal(r.toString(), 'brave new world');
    assert.equal(r.startContainer.textContent, 'brave');
    assert.equal(r.startOffset, 0);
    assert.equal(r.endContainer.textContent, 'world');
    assert.equal(r.endOffset, 5);
  });

  test('a quote inside one text node is a range inside that node', () => {
    const doc = setBody('<p id="q">the quick brown fox</p>');
    const r = findQuote(doc.getElementById('q'), 'quick brown');
    assert.equal(r.toString(), 'quick brown');
    assert.equal(r.startOffset, 4);
    assert.equal(r.endOffset, 15);
  });

  test('the first occurrence, so a repeated word anchors where it was read', () => {
    const doc = setBody('<p id="q">one <b>two</b> one two one</p>');
    const r = findQuote(doc.getElementById('q'), 'one');
    assert.equal(r.startContainer.textContent, 'one ');
    assert.equal(r.startOffset, 0);
  });

  test('not found is null, not a range over nothing', () => {
    const doc = setBody('<p id="q">hello</p>');
    assert.equal(findQuote(doc.getElementById('q'), 'goodbye'), null);
    assert.equal(findQuote(doc.getElementById('q'), ''), null);
    assert.equal(findQuote(setBody('<div id="n"><img></div>').getElementById('n'), 'x'), null);
  });

  test('it is matched case-sensitively', () => {
    const doc = setBody('<p id="q">Hello</p>');
    assert.equal(findQuote(doc.getElementById('q'), 'hello'), null);
    assert.equal(findQuote(doc.getElementById('q'), 'Hello').toString(), 'Hello');
  });

  // Worth being explicit about, because it is the shape of "the anchor cannot be found again":
  // the search is over the raw concatenated text, with no whitespace normalisation, while what
  // a selection reads back has its newlines and indentation collapsed.
  test('whitespace is not normalised: the quote has to be the text as it is written', () => {
    const doc = setBody('<p id="q">line one\n   line two</p>');
    assert.ok(findQuote(doc.getElementById('q'), 'line one\n   line two'));
    assert.equal(findQuote(doc.getElementById('q'), 'line one line two'), null);
  });

  test('a non-breaking space is a character of its own, not a space', () => {
    const doc = setBody('<p id="q">a\u00a0b</p>');
    assert.equal(findQuote(doc.getElementById('q'), 'a\u00a0b').toString(), 'a\u00a0b');
    assert.equal(findQuote(doc.getElementById('q'), 'a b'), null);
  });

  test('a line separator survives the round trip', () => {
    const doc = setBody('<p id="q">c\u2028d</p>');
    const r = findQuote(doc.getElementById('q'), 'c\u2028d');
    assert.equal(r.toString(), 'c\u2028d');
  });

  test('empty text nodes between the ends do not move the boundaries', () => {
    const doc = setBody('<div id="e"><span></span><b>ab</b><span></span><i>cd</i></div>');
    const r = findQuote(doc.getElementById('e'), 'bc');
    assert.equal(r.toString(), 'bc');
    assert.equal(r.startContainer.textContent, 'ab');
    assert.equal(r.startOffset, 1);
    assert.equal(r.endContainer.textContent, 'cd');
    assert.equal(r.endOffset, 1);
  });

  test('the search is confined to the container it was given', () => {
    const doc = setBody('<p id="a">needle</p><p id="b">haystack</p>');
    assert.equal(findQuote(doc.getElementById('b'), 'needle'), null);
    assert.ok(findQuote(doc.body, 'needle'));
  });
});

describe('pageKey: which page a pin belongs to', () => {
  test('path and query, never the hash - which is where the preview token lives', () => {
    assert.equal(window.location.href, 'http://localhost:5173/page?q=1#cc=abcdef1234');
    assert.equal(pageKey(), '/page?q=1');
    assert.equal(pageKey(), window.location.pathname + window.location.search);
    assert.ok(!pageKey().includes('#'));
    assert.ok(!pageKey().includes('cc='));
  });

  test('it moves with the page under a single-page app, hash changes aside', () => {
    window.history.pushState({}, '', '/other/route?tab=2#cc=abcdef1234&x=1');
    assert.equal(pageKey(), '/other/route?tab=2');
    window.location.hash = 'somewhere-else';
    assert.equal(pageKey(), '/other/route?tab=2');
    window.history.pushState({}, '', '/page?q=1#cc=abcdef1234'); // leave it as it was found
  });

  test('a bare path with no query is just the path', () => {
    window.history.pushState({}, '', '/');
    assert.equal(pageKey(), '/');
    window.history.pushState({}, '', '/page?q=1#cc=abcdef1234');
  });
});

/**
 * The extension transport, which is not on the `__ccTest` seam and must not be: it is the one
 * thing in this file that can reach outside the page, and the seam's rule is that nothing it
 * hands out can. So it is driven the way the browser drives it, from outside.
 *
 * It is here because of a regression that every one of the tests above stayed green through.
 * `askExtension` registers the settler for a reply under the message id, and one rewrite dropped
 * that registration: the settler's own `if (!pending.delete(id)) return;` then fired on an answer
 * AND on the timeout, so the promise never settled, either way. Send begins with an `await` on
 * this transport, so the button simply spun forever and no comment ever reached the daemon.
 *
 * Nothing here needs a trusted event: the overlay asks the extension once at start-up, to decide
 * whether screenshots are silent, and writes the answer onto the panel's screenshot line. That
 * line is the observable - two different sentences for "yes" and "no", so the test can also tell
 * an answer apart from a timeout - and it makes every ask a round trip through the real
 * `askExtension`, in the page world, with no production code widened to see it.
 *
 * Each case gets its own window: `hasExtension` caches the answer in `extReady` for the life of
 * the page, so one window could only ever be asked once.
 */
describe('askExtension: an ask always settles - answered, answered with rubbish, or not at all', () => {
  const YES = 'Captured by the extension - no prompt';
  const NO = 'No extension: each send asks to share the tab';
  const shot = (page) => page.shadow.querySelector('.shot');

  /** The ask itself: one ping, addressed to the relay, carrying an id for the answer to come back on. */
  const assertPinged = (page) => {
    assert.deepEqual(page.requests.map((r) => r.type), ['ping']);
    const [req] = page.requests;
    assert.equal(req.__cc, 'req');
    assert.equal(typeof req.id, 'number');
    // Its own keys, not the object: it was built in the jsdom realm, where `{}` is a different
    // `Object` from this file's and a strict deep-equal against one fails on the prototype alone.
    assert.deepEqual(Object.keys(req.payload), []);
  };

  test('an answered ping settles, well inside the timeout it never reaches', { timeout: 20000 }, async () => {
    const page = await overlayWindow({
      relay: (req, reply) => { if (req.type === 'ping') reply({ ok: true }); },
    });
    try {
      // 1500ms is an assertion, not patience: the ping's own timeout is 2000ms, so settling
      // inside this can only be the answer arriving, never the transport giving up on it.
      await waitFor(() => shot(page).title === YES, 'the answered ping never reached its caller', 1500);
      assert.ok(shot(page).classList.contains('auto'));
      assert.equal(page.shadow.querySelector('.shottext').textContent, 'screenshot attached');
      assertPinged(page);
    } finally {
      page.close();
    }
  });

  // `respond()` with no argument, a port that closed, or - in the page world, which the page
  // itself shares - anything at all posted at the window under a matching id.
  test('an answer that is not an object settles as the empty-answer error', { timeout: 20000 }, async () => {
    const page = await overlayWindow({ relay: (req, reply) => reply(undefined) });
    try {
      await waitFor(() => shot(page).title === NO, 'an empty answer left the caller waiting', 1500);
      assert.ok(!shot(page).classList.contains('auto'));
      assertPinged(page);
    } finally {
      page.close();
    }
  });

  // The case that hung. Nothing answers - no relay, no extension, the state of any page the
  // bridge serves to a browser without the extension - and the only thing that can settle the
  // promise is the transport's own timeout.
  test('an unanswered ping settles on the timeout instead of waiting forever', { timeout: 20000 }, async () => {
    const page = await overlayWindow();
    try {
      await waitFor(() => shot(page).title === NO, 'the unanswered ping never timed out - Send would spin forever', 6000);
      assert.ok(!shot(page).classList.contains('auto'));
      assertPinged(page);
    } finally {
      page.close();
    }
  });
});
