import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionLine, extensionStatus, fmt, slackMessage, stoppedLine } from '../lib/format.mjs';

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
 * that works and one that looks identical and does nothing, so each state names the thing to do
 * about it - and the install path is the folder the daemon keeps the extension in, since that is
 * what the user has to point "Load unpacked" at, once, for good.
 */
describe('extensionLine', () => {
  const DIR = '/Users/someone/.config/local-artifact/extension';
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);

  test('never seen: the whole of the install, in one line', () => {
    assert.equal(
      extensionLine(null, DIR, now),
      'extension  NOT SEEN - install it: chrome://extensions -> Developer mode -> Load unpacked -> '
      + DIR,
    );
    // A record with no timestamp on it is the same thing as no record.
    assert.equal(extensionLine({ id: 'x' }, DIR, now), extensionLine(null, DIR, now));
  });

  test('seen recently: how long ago, and nothing to do', () => {
    assert.equal(extensionLine({ seenAt: now - 4000 }, DIR, now), 'extension  seen 4s ago');
    assert.equal(extensionLine({ seenAt: now - 90 * 1000 }, DIR, now), 'extension  seen 2m ago');
    // The boundary itself is still "recently"; a second past it is not.
    assert.match(extensionLine({ seenAt: now - (10 * 60 * 1000 - 1) }, DIR, now), /^extension {2}seen /);
    assert.match(extensionLine({ seenAt: now - 10 * 60 * 1000 }, DIR, now), /^extension {2}last seen /);
  });

  test('seen long ago: it was there once, so say what may have happened to it', () => {
    assert.equal(
      extensionLine({ seenAt: now - 3 * 24 * 3600 * 1000 }, DIR, now),
      'extension  last seen 3d ago - open a page in Chrome; if no button appears, '
      + 'reload it at chrome://extensions',
    );
    assert.match(extensionLine({ seenAt: now - 2 * 3600 * 1000 }, DIR, now), /^extension {2}last seen 2h ago - /);
  });

  test('a clock that has gone backwards reads as now rather than as a negative age', () => {
    assert.equal(extensionLine({ seenAt: now + 5000 }, DIR, now), 'extension  seen 0s ago');
  });

  /**
   * An update has reached the folder and the running extension has not caught up yet. It reloads
   * itself on the bridge's next answer, so the line says so - rather than send someone to
   * chrome://extensions for something that is a page load away.
   */
  test('behind the folder: both versions, and that it updates itself', () => {
    const one = { id: 'a'.repeat(32), version: '0.1.1', seenAt: now - 4000 };
    assert.equal(
      extensionLine({ seenAt: now - 4000, version: '0.1.1' }, DIR, now, { latest: '0.2.0', extensions: [one] }),
      'extension  seen 4s ago - extension 0.1.1, plugin 0.2.0 - it updates itself within a page load or two',
    );
    // Level with the folder, or ahead of it - a copy loaded from a checkout - is nothing to report.
    for (const version of ['0.2.0', '0.3.0']) {
      assert.equal(
        extensionLine({ seenAt: now - 4000, version }, DIR, now, { latest: '0.2.0', extensions: [{ ...one, version }] }),
        'extension  seen 4s ago',
      );
    }
  });

  /**
   * A copy from before self-update says no version at all, and never will: it is the zip install,
   * loaded from a folder nothing updates. On its own it is the only extension there is, so the fix
   * is both halves - take it out, and load the folder that does update.
   */
  test('no version, on its own: an old copy - remove it and load the folder', () => {
    const old = { id: 'a'.repeat(32), version: null, seenAt: now - 4000 };
    assert.equal(
      extensionLine({ seenAt: now - 4000, version: null }, DIR, now, { latest: '0.2.0', extensions: [old] }),
      'extension  seen 4s ago - an old copy that cannot update itself; remove it at chrome://extensions '
      + `and load ${DIR} instead`,
    );
  });

  // A daemon from before versions reports neither, and cannot tell an old copy from a new one.
  test('from a daemon too old to say, no version is not news', () => {
    assert.equal(extensionLine({ seenAt: now - 4000 }, DIR, now, {}), 'extension  seen 4s ago');
  });

  /**
   * Two ids in the last ten minutes: two copies loaded side by side, each putting its own overlay
   * on every page. Whichever spoke last is the one the first line describes; the warning is about
   * the pair, and names the folder to keep.
   */
  test('two copies loaded at once: a warning under the line', () => {
    const fresh = { id: 'a'.repeat(32), version: '0.2.0', seenAt: now - 4000 };
    const zip = { id: 'b'.repeat(32), version: null, seenAt: now - 60 * 1000 };
    assert.equal(
      extensionLine({ seenAt: now - 4000, version: '0.2.0' }, DIR, now, { latest: '0.2.0', extensions: [fresh, zip] }),
      'extension  seen 4s ago\n'
      + 'WARNING    an older copy of the extension is also loaded - remove it at chrome://extensions, '
      + `keeping the one loaded from ${DIR}`,
    );
    // The same when the old copy is the one that spoke last: the pair is the problem either way.
    assert.match(
      extensionLine({ seenAt: now - 4000, version: null }, DIR, now, { latest: '0.2.0', extensions: [fresh, zip] }),
      /^extension {2}seen 4s ago\nWARNING {4}an older copy of the extension is also loaded/,
    );
    // An id last heard from outside the window was removed, or is in another Chrome profile.
    const gone = { ...zip, seenAt: now - 11 * 60 * 1000 };
    assert.equal(
      extensionLine({ seenAt: now - 4000, version: '0.2.0' }, DIR, now, { latest: '0.2.0', extensions: [fresh, gone] }),
      'extension  seen 4s ago',
    );
  });

  test('extensionStatus reads all of it from /health, and the folder from the daemon first', () => {
    const h = {
      extension: { seenAt: now - 4000, id: 'a'.repeat(32), version: '0.1.0' },
      extensions: [{ id: 'a'.repeat(32), version: '0.1.0', seenAt: now - 4000 }],
      extDir: { path: '/daemon/says/extension', version: '0.2.0' },
    };
    assert.match(extensionStatus(h, DIR, now), /extension 0\.1\.0, plugin 0\.2\.0/);
    assert.match(extensionStatus({ extension: null, extDir: h.extDir }, DIR, now), /-> \/daemon\/says\/extension$/);
    // An older daemon names no folder; the caller's own is the only answer there is.
    assert.match(extensionStatus({ extension: null }, DIR, now), new RegExp(`-> ${DIR}$`));
    assert.match(extensionStatus(null, DIR, now), /NOT SEEN/);
  });
});

/**
 * The one warning the other sessions get when the bridge is stopped: they are never told. Counted
 * from what /shutdown answered with, leaving out the session asking and any that had disconnected,
 * since neither was receiving anything to lose.
 */
describe('stoppedLine', () => {
  test('names the other sessions that lose their comments, not the one asking', () => {
    const was = [
      { key: 'p1', repo: 'mine', primary: true },
      { key: 'p2', repo: 'web' },
      { key: 'p3', repo: 'api', detached: true },
      { key: 'p4', repo: '' },
    ];
    assert.equal(stoppedLine(was, 'p1'),
      'stopped the bridge; 2 other sessions lose comments until someone runs /connect: web, p4');
    assert.equal(stoppedLine(was.slice(0, 2), 'p1'),
      'stopped the bridge; 1 other session loses comments until someone runs /connect: web');
  });

  test('with nobody else, says what starts it again', () => {
    assert.equal(stoppedLine([{ key: 'p1', repo: 'mine' }], 'p1'),
      'stopped the bridge; no other session was connected - /connect starts it again');
    assert.equal(stoppedLine([], null),
      'stopped the bridge; no other session was connected - /connect starts it again');
  });
});
