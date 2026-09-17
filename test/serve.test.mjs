import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { injectOverlay, kindOf, overlayTags, safeJoin } from '../bridge/serve.mjs';
import { wrapperPage } from '../bridge/wrapper.mjs';

test('safeJoin refuses paths that escape the root', () => {
  assert.equal(safeJoin('/srv/root', 'a/b.png'), '/srv/root/a/b.png');
  assert.equal(safeJoin('/srv/root', '../../etc/passwd'), '/srv/root/etc/passwd');
  assert.equal(safeJoin('/srv/root', ''), '/srv/root');
});

test('overlayTags escapes what it is given', () => {
  const tags = overlayTags({ previewId: 'ab"cd', repo: 'r<e>"po' });
  assert.match(tags, /data-cc-preview="ab&quot;cd"/);
  assert.match(tags, /data-cc-repo="r&lt;e&gt;&quot;po"/);
  assert.ok(tags.indexOf('console-hook.js') < tags.indexOf('overlay.js'));
});

test('injectOverlay goes before the last closing tag, or at the end', () => {
  assert.equal(injectOverlay('<body>"</body>"</body>', 'T'), '<body>"</body>"T\n</body>');
  assert.equal(injectOverlay('<html><p>x</html>', 'T'), '<html><p>xT\n</html>');
  assert.equal(injectOverlay('<p>x', 'T'), '<p>xT');
});

test('markdown keeps ordinary links and drops script ones', () => {
  const page = wrapperPage({
    kind: 'markdown', title: 't', tags: '',
    text: '[ok](https://example.com) [rel](./a.md) [bad](javascript:void0) [ctl](\x01JavaScript:void0)',
  });
  assert.match(page, /<a href="https:\/\/example\.com"/);
  assert.match(page, /<a href="\.\/a\.md"/);
  assert.doesNotMatch(page, /href="[^"]*javascript/i);
  assert.match(page, /<\/a> bad ctl<\/p>/); // the text stays, the link goes
});

/**
 * The wrapper page shares its origin with the bridge's own API, so a link in a note that a
 * browser would run as script is script running next to /comment, /preview and the token that
 * guards them. `safeHref` in bridge/wrapper.mjs is the only thing standing there, and it is
 * reached through `wrapperPage` - it is not exported. A refused link keeps its text and loses
 * its anchor, so "no <a" is the whole assertion.
 */
describe('a markdown link that a browser would run as script', () => {
  /** The note as /p/<id>/ serves it, cut down to the part renderMarkdown produced. */
  const rendered = (markdown) => {
    const page = wrapperPage({ kind: 'markdown', title: 't', tags: '', text: markdown });
    return page.slice(page.indexOf('<article'), page.indexOf('</article>'));
  };

  // A browser's URL parser drops control characters and spaces before it reads the scheme, so
  // safeHref has to as well - each of these is `javascript:` as far as navigation is concerned.
  // Written as \x escapes deliberately: a raw control byte in a test file is invisible to review.
  const refused = {
    'plain': 'javascript:alert(1)',
    'in mixed case': 'JaVaScRiPt:alert(1)',
    'with a NUL in the middle of the scheme': 'java\x00script:alert(1)',
    'behind a control character': '\x01javascript:alert(1)',
    'with a control character before the colon': 'javascript\x1f:alert(1)',
    'as a data URL': 'data:text/html,hello',
    'as vbscript': 'vbscript:alert(1)',
  };

  for (const [how, href] of Object.entries(refused)) {
    test(`is not a link when it is written ${how}`, () => {
      const html = rendered(`[click](${href})`);
      assert.doesNotMatch(html, /<a\b/, html);
      assert.match(html, /<p>click/, 'the text of the link stays, only the link goes');
    });
  }

  const kept = {
    'https': 'https://example.com/x',
    'mailto': 'mailto:a@b.example',
    'a relative path': 'a/note.md',
    'an anchor on the page itself': '#section',
  };

  for (const [what, href] of Object.entries(kept)) {
    test(`still links ${what}`, () => {
      assert.ok(
        rendered(`[click](${href})`).includes(`<a href="${href}" rel="noreferrer">click</a>`),
        href,
      );
    });
  }

  // The cases safeHref can never be asked about, so nothing here pretends to test it: the link
  // pattern in renderMarkdown is `[^)\s]+` and it runs a line at a time, so a href holding a
  // space, a tab or a newline is not a link at all - the source is left standing as text.
  test('cannot be written with a space, a tab or a newline in the scheme', () => {
    for (const gap of [' ', '\t', '\n']) {
      const html = rendered(`[click](java${gap}script:alert(1))`);
      assert.doesNotMatch(html, /<a\b/, JSON.stringify(gap));
      assert.match(html, /\[click\]\(java/, 'not a link, so not even the brackets are consumed');
    }
  });
});

test('kindOf', () => {
  assert.equal(kindOf('a.HTML'), 'html');
  assert.equal(kindOf('a.pdf'), 'pdf');
  assert.equal(kindOf('a.markdown'), 'markdown');
  assert.equal(kindOf('a.svg'), 'image');
  assert.equal(kindOf('a.json'), 'text');
});
