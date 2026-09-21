import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HOST } from '../lib/common.mjs';
import { startBridge } from './helpers.mjs';

/**
 * What the extension cannot import, and therefore holds a copy of.
 *
 * The service worker is a classic script and the README is prose: neither can read
 * `lib/common.mjs`, and there is no build step to hand them anything. Where a copy drifts the
 * symptom is silence - a comment sent to nobody, an overlay that never appears - so the copies
 * are pinned here, in text and, where it is a function, in behaviour.
 */
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** The port this repo ships, not `PORT`: this process may itself have been started on another. */
const DEFAULT_PORT = Number(/LOCAL_ARTIFACT_PORT \|\| (\d+)/.exec(read('lib/common.mjs'))?.[1]);

/**
 * The text of a function, however it is declared - `function f(…) {…}` or `const f = (…) => {…}`.
 * Braces are counted rather than matched loosely, and none of these bodies contains one inside a
 * string or a regex, so the count is the end of the function.
 */
function fnSource(text, name) {
  const at = text.search(new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`));
  assert.notEqual(at, -1, `${name} is no longer declared here`);
  let depth = 0;
  for (let i = text.indexOf('{', at); i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(at, i + 1);
  }
  throw new Error(`${name} has unbalanced braces`);
}

/** The same source as a callable, so a copy can be tested rather than only compared. */
const strip = (src) => src.replace(/^(?:const|let|var)\s+[\w$]+\s*=\s*/, '').replace(/;\s*$/, '');
const asFunction = (src) => new Function(`return (${strip(src)});`)();

test('the service worker and the README both speak to the default port', () => {
  assert.equal(DEFAULT_PORT, 4517);
  const origin = `http://${HOST}:${DEFAULT_PORT}`;
  // `LOCAL_ARTIFACT_PORT` moves the daemon and not the extension, which is a thing the README has
  // to say rather than a thing to fix: the worker is pinned to the bridge's exact origin.
  for (const file of ['extension/background.js', 'README.md']) {
    assert.ok(read(file).includes(origin), `${file} no longer contains ${origin} - the copies have drifted`);
  }
});

/**
 * Three runtimes - the popup page, the service worker, Node - with no module system between them.
 * They stay three copies; what they may not do is disagree, because the failure is a comment
 * routed nowhere rather than an error anybody sees.
 */
describe('originOf, once per runtime', () => {
  const files = ['extension/popup.js', 'extension/background.js', 'bridge/server.mjs'];
  const sources = files.map((file) => [file, fnSource(read(file), 'originOf')]);

  test('the two extension copies are the same function', () => {
    const [popup, worker] = sources.map(([, src]) => strip(src).replace(/\s+/g, ' '));
    assert.equal(popup, worker, 'the popup and the worker no longer agree');
  });

  test('and all three answer the same for everything a tab can be showing', () => {
    const cases = [
      ['http://localhost:5173', 'http://localhost:5173'],
      ['http://localhost:5173/a?b=1#c', 'http://localhost:5173'],
      ['https://deployed.example/x', 'https://deployed.example'],
      // A host is case-insensitive and a path is not; the bridge keys bindings on this string.
      ['http://EXAMPLE.com/X', 'http://example.com'],
      ['http://example.com./x', 'http://example.com.'],
      ['http://x:8080/', 'http://x:8080'],
      // A default port is not part of an origin, so these must not come back with one.
      ['http://x:80/', 'http://x'],
      ['https://x:443/', 'https://x'],
      ['http://[::1]:5173/', 'http://[::1]:5173'],
      // Nothing below is a page a comment could come from, and each one reaches this function:
      // chrome:// and the web store on a tab switch, file: and about:blank from the popup.
      ['file:///tmp/a.html', null],
      ['chrome://extensions', null],
      ['about:blank', null],
      ['javascript:alert(1)', null],
      ['data:text/html,x', null],
      ['ftp://x/', null],
      ['', null],
      ['not a url', null],
      [undefined, null],
    ];
    for (const [file, src] of sources) {
      const originOf = asFunction(src);
      for (const [url, want] of cases) {
        assert.equal(originOf(url), want, `${file} on ${JSON.stringify(url)}`);
      }
    }
  });
});

test('the bridge numbers a page by the key the overlay computes', () => {
  const pageKey = asFunction(fnSource(read('bridge/server.mjs'), 'pageKey'));
  // The overlay's copy is `() => location.pathname + location.search` - it reads `location`, so it
  // cannot be lifted out and called. What is pinned instead is the definition the server is
  // written against, plus the fact that the overlay still computes that and not something else.
  assert.ok(
    read('extension/overlay.js').includes('location.pathname + location.search'),
    'the overlay no longer keys a page on pathname + search',
  );
  const cases = [
    ['http://localhost:5173/', '/'],
    ['http://localhost:5173/a?x=1', '/a?x=1'],
    ['http://localhost:5173/a?x=1#/route', '/a?x=1'],
    // An SPA route in the hash is one page as far as numbering goes - that is the overlay's rule.
    ['http://localhost:5173/#/route', '/'],
    ['https://deployed.example', '/'],
    ['', ''],
  ];
  for (const [url, key] of cases) assert.equal(pageKey(url), key, url);
});

const EXT = { origin: 'chrome-extension://abc' };

/**
 * Errors cross this boundary as prose, and prose gets reworded. `code` is the part the popup and
 * the panel are allowed to branch on; the sentence beside it stays the one a person reads.
 */
test('a failing Slack route says why in a code, not only in a sentence', async () => {
  const bridge = await startBridge();
  try {
    const res = await bridge.request('/slack/destinations?q=', { token: null, headers: EXT });
    // Nothing is connected in a test daemon's own config directory - slack.mjs calls that a 409.
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.ok(j.code, `no code beside ${JSON.stringify(j.error)}`);
    assert.equal(typeof j.code, 'string');
    assert.match(j.error, /not connected/, 'and the sentence is still the human one');
  } finally {
    await bridge.stop();
  }
});
