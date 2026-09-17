import { test } from 'node:test';
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
    text: '[ok](https://example.com) [rel](./a.md) [bad](javascript:void0) [ctl](JavaScript:void0)',
  });
  assert.match(page, /<a href="https:\/\/example\.com"/);
  assert.match(page, /<a href="\.\/a\.md"/);
  assert.doesNotMatch(page, /href="[^"]*javascript/i);
  assert.match(page, /<\/a> bad ctl<\/p>/); // the text stays, the link goes
});

test('kindOf', () => {
  assert.equal(kindOf('a.HTML'), 'html');
  assert.equal(kindOf('a.pdf'), 'pdf');
  assert.equal(kindOf('a.markdown'), 'markdown');
  assert.equal(kindOf('a.svg'), 'image');
  assert.equal(kindOf('a.json'), 'text');
});
