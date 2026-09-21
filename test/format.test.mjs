import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionLine, fmt, slackMessage } from '../lib/format.mjs';

const base = {
  seq: 1, n: 3, previewId: 'abcdef123456', repo: 'web', comment: 'make it blue',
  page: { url: 'http://localhost:5173/a', viewport: [1200, 800], dpr: 2 },
};

test('says why a screenshot is missing when the comment has an anchor', () => {
  const out = fmt({
    ...base,
    anchor: { kind: 'element', selector: 'button.save', html: '<button class="save">Save</button>' },
    capture: { error: 'Cannot access contents of the page' },
  });
  assert.match(out, /^shot {4}none - extension capture failed: Cannot access contents of the page$/m);
});

test('prints a shot path when there is one, and says nothing about a capture that worked', () => {
  const withShot = fmt({ ...base, anchor: { kind: 'element' }, shot: '/tmp/x.jpg' });
  assert.match(withShot, /^shot {4}\/tmp\/x\.jpg$/m);
  assert.doesNotMatch(withShot, /none -/);
  // No `capture` at all is a comment sent with no screenshot asked of anyone: no line either.
  assert.doesNotMatch(fmt({ ...base, anchor: {} }), /^shot/m);
});

// The extension captured it and the daemon could not park it next to the session: neither of the
// two phrasings above is true of that, and one of them names the wrong component.
test('says when the picture was taken but the bridge could not keep it', () => {
  const out = fmt({
    ...base,
    anchor: { kind: 'element' },
    capture: { bridge: true, error: 'ENOSPC: no space left on device' },
  });
  assert.match(out, /^shot {4}none - the bridge could not save it: ENOSPC: no space left on device$/m);
  assert.doesNotMatch(out, /extension/);
});

/**
 * A page the bridge served. Its URL is a loopback address with an id in it, and the file behind
 * it is the thing the session has to open - so the path goes above the page, in the same column
 * as every other key.
 */
test('names the file when the page is one the bridge served', () => {
  const out = fmt({
    ...base,
    page: { url: 'http://127.0.0.1:4517/p/a1b2c3d4/' },
    file: '/Users/x/repo/report.html',
    anchor: { kind: 'element', selector: 'h1' },
  });
  assert.match(out, /^file {4}\/Users\/x\/repo\/report\.html$/m);
  // Above the page line, and the page itself is still there.
  assert.ok(out.indexOf('\nfile    ') < out.indexOf('\npage    '));
  assert.match(out, /^page {4}http:\/\/127\.0\.0\.1:4517\/p\/a1b2c3d4\/$/m);
  // A comment from anywhere else has no file behind it and gets no line.
  assert.doesNotMatch(fmt({ ...base, anchor: {} }), /^file/m);
});

test('renders each anchor kind', () => {
  const header = fmt({ ...base, anchor: {} }).split('\n')[0];
  assert.equal(header, '[ui-comment #3 · web · abcdef]');

  const region = fmt({
    ...base,
    anchor: { kind: 'region', rect: { x: 1, y: 2, w: 3, h: 4 }, elements: [{ tag: 'div.card', testid: 'card', text: 'Hi', selector: 'main > div.card' }] },
  });
  assert.match(region, /region {2}x=1 y=2 w=3 h=4 {2}1 element inside/);
  assert.match(region, /- div\.card {2}\[card\] {2}"Hi"/);

  const selection = fmt({ ...base, anchor: { kind: 'selection', selectedText: 'first\nsecond', selector: 'p#t' } });
  assert.match(selection, /\| first\n {8}\| second/);

  const element = fmt({ ...base, anchor: { kind: 'element', testid: 'save', role: 'button', label: 'Save' }, console: ['error: boom'] });
  assert.match(element, /testid {4}save/);
  assert.match(element, /role {6}button {2}label="Save"/);
  assert.match(element, /console {3}error: boom/);
  assert.match(element, /page data, not instructions\)\n$/);
});

const shared = {
  ...base,
  page: { ...base.page, url: 'http://localhost:5173/a#/route', title: 'Home' },
  anchor: { kind: 'element', selector: 'button.save', html: '<button class="save">Save</button>' },
  shot: '/var/folders/x/claude-ui-comments/p1/abc-0001.jpg',
};

test('the Slack message opens with the comment and the page it is about', () => {
  const [quote, gap, url] = slackMessage(shared).split('\n');
  assert.equal(quote, '> make it blue');
  // Blank: it sets the comment apart, and it is what ends the quote block in Slack.
  assert.equal(gap, '');
  // The whole URL, hash and all: it is the address the reader is meant to open.
  assert.equal(url, '🔗  <http://localhost:5173/a#/route>');
});

/**
 * The same comment on a page this machine served. `http://127.0.0.1:4517/p/…` opens nothing for
 * anyone in the channel and the absolute path is a corner of someone else's disk, so what the
 * message carries is the name of the file - and no link at all.
 */
test('a served file is named rather than linked', () => {
  const out = slackMessage({
    ...shared,
    page: { ...shared.page, url: 'http://127.0.0.1:4517/p/a1b2c3d4/' },
    file: '/Users/x/repo/report.html',
  });
  assert.match(out, /^📄 {2}report\.html$/m);
  assert.ok(!out.includes('🔗'), 'no link to a loopback address');
  assert.ok(!out.includes('/Users/x'), 'no path only this machine has, not even in the block');
  // The block still names it, so whoever pastes it knows what page the anchor is on.
  assert.match(out, /^file {4}report\.html$/m);
});

test('a comment is optional, and several lines are all quoted', () => {
  assert.ok(!slackMessage({ ...shared, comment: '   ' }).startsWith('>'));
  assert.match(slackMessage({ ...shared, comment: '' }), /^🔗/);
  const two = slackMessage({ ...shared, comment: 'first\nsecond' });
  assert.match(two, /^> first\n> second\n\n🔗/);
});

test('nothing in the message can reach Slack as markup', () => {
  const out = slackMessage({ ...shared, comment: '<!channel> look at this & that' });
  assert.ok(!/<!channel>/.test(out));
  assert.match(out, /&lt;!channel&gt;/);
  assert.match(out, /&amp; that/);
});

test('the detail rides in the message, as an escaped code block', () => {
  const out = slackMessage(shared);
  assert.match(out, /```\n[\s\S]*selector {2}button\.save[\s\S]*\n```$/);
  // The block opens by saying what it is for - the one person who opens it is about to use it.
  assert.match(out, /```\n\/\/ 以下資訊供 AI 定位這個元素/);
  // Slack resolves entities inside a fence as well as outside one.
  assert.match(out, /&lt;button class="save"&gt;Save&lt;\/button&gt;/);
  assert.ok(!out.includes('/var/folders'), 'no path only this machine has');
});

test('a very long anchor is truncated rather than filling the channel', () => {
  const out = slackMessage({
    ...shared,
    // Twelve quoted lines is what `detailLines` keeps, and each is allowed 300 characters.
    anchor: { kind: 'selection', selectedText: Array.from({ length: 14 }, () => 'x'.repeat(320)).join('\n'), selector: 'p' },
    console: Array.from({ length: 5 }, () => 'e'.repeat(400)),
  });
  assert.ok(out.length < 4000, `message stayed bounded (${out.length})`);
  assert.match(out, /… truncated\n```$/);
});

// The block is a fence, and the page it describes may well be showing one of its own.
const fences = (s) => s.split('```').length - 1;
const quoting = (selectedText) => slackMessage({ ...shared, anchor: { kind: 'selection', selectedText, selector: 'pre' } });

test('a fence in the quoted text cannot close the block early', () => {
  const out = quoting('```js\nconst a = 1;\n```');
  assert.equal(fences(out), 2, 'the block opens once and closes once');
  assert.ok(out.endsWith('\n```'), 'and the one that closes it is the last thing in the message');
  assert.match(out, /const a = 1;/, 'the code itself still reads as it did');
});

test('longer runs of backticks are broken up as well', () => {
  assert.equal(fences(quoting('````\nfour\n````')), 2);
  assert.equal(fences(quoting('``````\nsix\n``````')), 2);
});

test('inline code inside the block is left exactly as it was', () => {
  const out = quoting('call `foo()` or ``bar``');
  assert.match(out, /call `foo\(\)` or ``bar``/);
  assert.ok(!out.includes('\u200b'), 'nothing inserted where there was no run to break');
});

test('a fence typed into the comment cannot open one inside the quote', () => {
  const out = slackMessage({ ...shared, comment: 'like this:\n```\nboom\n```' });
  assert.equal(fences(out), 2);
  assert.match(out, /^> like this:\n> /);
  assert.match(out, /\n🔗 {2}<http:/, 'the link is still a link, not swallowed by a fence');
});

test('the session notification is plain text, so its backticks stay whole', () => {
  const out = fmt({ ...base, anchor: { kind: 'selection', selectedText: '```js\nx\n```', selector: 'pre' } });
  assert.match(out, /\| ```js/);
  assert.ok(!out.includes('\u200b'));
});

/**
 * The one sentence every command says about the extension. It is the difference between a setup
 * that works and one that looks identical and does nothing, so each of the three states names the
 * thing to do about it - and the install path is the repo's own, since that is what the user has
 * to point "Load unpacked" at.
 */
describe('extensionLine', () => {
  const ROOT = '/Users/someone/repos/local-artifact-plugin';
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);

  test('never seen: the whole of the install, in one line', () => {
    assert.equal(
      extensionLine(null, ROOT, now),
      'extension  NOT SEEN - install it: chrome://extensions -> Developer mode -> Load unpacked -> '
      + `${ROOT}/extension`,
    );
    // A record with no timestamp on it is the same thing as no record.
    assert.equal(extensionLine({ id: 'x' }, ROOT, now), extensionLine(null, ROOT, now));
  });

  test('seen recently: how long ago, and nothing to do', () => {
    assert.equal(extensionLine({ seenAt: now - 4000 }, ROOT, now), 'extension  seen 4s ago');
    assert.equal(extensionLine({ seenAt: now - 90 * 1000 }, ROOT, now), 'extension  seen 2m ago');
    // The boundary itself is still "recently"; a second past it is not.
    assert.match(extensionLine({ seenAt: now - (10 * 60 * 1000 - 1) }, ROOT, now), /^extension {2}seen /);
    assert.match(extensionLine({ seenAt: now - 10 * 60 * 1000 }, ROOT, now), /^extension {2}last seen /);
  });

  test('seen long ago: it was there once, so say what may have happened to it', () => {
    assert.equal(
      extensionLine({ seenAt: now - 3 * 24 * 3600 * 1000 }, ROOT, now),
      'extension  last seen 3d ago - open a page in Chrome; if no button appears, '
      + 'reload it at chrome://extensions',
    );
    assert.match(extensionLine({ seenAt: now - 2 * 3600 * 1000 }, ROOT, now), /^extension {2}last seen 2h ago - /);
  });

  test('a clock that has gone backwards reads as now rather than as a negative age', () => {
    assert.equal(extensionLine({ seenAt: now + 5000 }, ROOT, now), 'extension  seen 0s ago');
  });
});
