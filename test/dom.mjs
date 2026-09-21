/**
 * Runs the real, unmodified extension/overlay.js inside a DOM, and hands back the pure
 * functions it exposes through its `window.__ccTest` seam.
 *
 * The overlay is one classic-script IIFE loaded three different ways (extension injection,
 * a <script src> from the bridge, the README bookmarklet), so it is deliberately not split
 * into modules and cannot be imported. The only honest way to test it is to execute the file
 * the browser executes - which is what jsdom is the single devDependency for. Nothing under
 * lib/, bridge/, scripts/ or extension/ may import from here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const OVERLAY_SRC = path.join(ROOT, 'extension', 'overlay.js');

/**
 * The plugin runs from a directory where nobody has run `npm install`, so a missing jsdom is
 * the normal state of a fresh checkout rather than a broken one. These tests still fail rather
 * than skip: they are the only cover the overlay's 2700 lines have, and a suite that quietly
 * reports "0 failures" on a checkout that ran none of them is worse than one line of setup.
 */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  throw new Error(
    'test/overlay.test.mjs executes extension/overlay.js inside a DOM and needs the one '
    + 'devDependency. Run `npm install`. The plugin itself has zero runtime dependencies and '
    + 'does not need node_modules to work.',
  );
}

const SOURCE = fs.readFileSync(OVERLAY_SRC, 'utf8');

/**
 * A window with the overlay already loaded in it.
 *
 * The overlay closes over the `document` it started in, so every fixture has to be written into
 * that same document - hence `setBody` rather than a fresh window per case. Building one window
 * costs about a tenth of a second; building one per fixture would cost more than the rest of the
 * suite put together.
 *
 * `chrome` is absent, which is the bridge-served/bookmarklet path: the overlay decides `isolated`
 * once at start-up, so this is the world the seam is reasoned about in.
 *
 * `relay` stands in for extension/content.js. In the page world the overlay asks the extension by
 * posting `{ __cc: 'req', id, type, payload }` at its own window and reading the answer off a
 * `{ __cc: 'res', id, payload }` message; given a relay, `relay(req, reply)` is called for each
 * ask and `reply(payload)` answers it. Every ask is recorded in `requests` either way, so a test
 * can also assert on what was asked while nothing answers.
 */
export async function overlayWindow({ url = 'http://localhost:5173/page?q=1#cc=abcdef1234', relay = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
    runScripts: 'dangerously',
    // Gives the window requestAnimationFrame, which the overlay wants at start-up.
    pretendToBeVisual: true,
  });
  const { window } = dom;

  let api = null;
  window.__ccTest = (exposed) => { api = exposed; };

  // Listening before the overlay loads, because the first ask is made at start-up. jsdom leaves
  // `source` null on a `postMessage`, and the overlay ignores any answer whose source is not its
  // own window - so an answer is dispatched as the MessageEvent a browser would have delivered.
  const requests = [];
  window.addEventListener('message', (e) => {
    if (e.data?.__cc !== 'req') return;
    requests.push(e.data);
    relay?.(e.data, (payload) => window.dispatchEvent(new window.MessageEvent('message', {
      data: { __cc: 'res', id: e.data.id, payload }, source: window, origin: window.origin,
    })));
  });

  /**
   * The overlay's UI lives in a CLOSED shadow root, so `host.shadowRoot` is null - that is the
   * point of it, and nothing here weakens it: the overlay is handed the same closed root it asked
   * for, and this keeps the reference its own constructor returned, the way devtools can see one.
   * It is test-side only - the file under test is unchanged and learns nothing - and it is what
   * lets a test see the panel the user sees instead of widening the `__ccTest` seam to reach it.
   */
  let shadow = null;
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function patched(init) {
    const root = attachShadow.call(this, init);
    if (this.id === 'cc-overlay-host') shadow = root;
    return root;
  };

  // An inline <script> with the data- attributes the bridge writes: this is the loader whose
  // `document.currentScript.dataset` branch the overlay reads its config from.
  try {
    const script = window.document.createElement('script');
    script.dataset.ccPreview = 'abcdef1234';
    script.dataset.ccOrigin = 'http://127.0.0.1:4317';
    script.textContent = SOURCE;
    window.document.body.appendChild(script);
    script.remove();
  } finally {
    window.Element.prototype.attachShadow = attachShadow;
  }

  if (!api) throw new Error('overlay.js did not reach its __ccTest seam - it stopped early');

  // The overlay's own host is a <div> child of <body>. Left there it would be counted as a
  // sibling by :nth-of-type and swept up by "every element in the document", so the fixtures
  // get the document to themselves. Nothing the seam exposes reads `host`.
  window.document.getElementById('cc-overlay-host')?.remove();

  return {
    window,
    document: window.document,
    api,
    /** The overlay's own closed shadow root, and every `{ __cc: 'req' }` it has posted. */
    shadow,
    requests,
    /** Replaces the whole page. Returns the document for convenience. */
    setBody(html) {
      window.document.body.innerHTML = html;
      return window.document;
    },
    /** Takes the window's timers down with it, so the test process can exit. */
    close: () => window.close(),
  };
}

/**
 * Waits for something the overlay does asynchronously, and FAILS rather than hangs when it never
 * happens - the whole point of the transport tests below is a promise that never settled, and a
 * test that waits forever on one reports nothing at all. `within` is also an assertion: a deadline
 * shorter than the overlay's own timeout is how "it answered" is told apart from "it timed out".
 */
export async function waitFor(cond, message, within = 4000) {
  const until = Date.now() + within;
  for (;;) {
    if (cond()) return;
    if (Date.now() > until) throw new Error(`${message} (nothing within ${within}ms)`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every element of the page, in document order - what a "for every element" sweep runs over. */
export const allElements = (document) => [...document.body.querySelectorAll('*')];
