/**
 * Runs the real, unmodified extension/overlay.js inside a DOM, and hands back what it exposes
 * through its `window.__ccTest` seam.
 *
 * The overlay is one classic-script IIFE injected into the extension's isolated world, so it is
 * deliberately not split into modules and cannot be imported. The only honest way to test it is
 * to execute the file the browser executes - which is what jsdom is the single devDependency
 * for. Nothing under lib/, bridge/, scripts/ or extension/ may import from here.
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
 * One origin's localStorage, for several windows at once - the way two tabs on one origin share
 * it in a browser, which separate jsdom windows do not. Pass it to `overlayWindow({ shared })`.
 * A write in one window fires `storage` in each of the others and never in the writer, after the
 * write, as a browser does; `flush()` waits for those events to have been delivered.
 */
export function sharedStorage() {
  const map = new Map();
  const windows = new Set();
  const notify = (from, key, oldValue, newValue) => {
    for (const w of windows) {
      if (w === from) continue;
      w.setTimeout(() => w.dispatchEvent(new w.StorageEvent('storage', {
        key, oldValue, newValue, url: from.location.href,
      })), 0);
    }
  };
  const area = (win) => ({
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem(k, v) {
      const old = this.getItem(k);
      map.set(String(k), String(v));
      notify(win, String(k), old, String(v));
    },
    removeItem(k) {
      const old = this.getItem(k);
      map.delete(String(k));
      notify(win, String(k), old, null);
    },
    clear() { map.clear(); notify(win, null, null, null); },
  });
  return {
    map,
    windows,
    area,
    flush: () => new Promise((r) => setTimeout(r, 20)),
  };
}

/**
 * A window with the overlay already loaded in it.
 *
 * The overlay closes over the `document` it started in, so every fixture has to be written into
 * that same document - hence `setBody` rather than a fresh window per case. Building one window
 * costs about a tenth of a second; building one per fixture would cost more than the rest of the
 * suite put together.
 *
 * The world is the one the extension injects into: `window.__ccConfig` is written first, and
 * `window.chrome` stands in for the extension - exactly the members the overlay touches at
 * start-up (`runtime.id`, `storage.local.get`, `storage.onChanged.addListener`) plus the
 * `runtime.sendMessage`/`runtime.lastError` pair its transport uses.
 *
 * `sendMessage(msg, respond)` is the worker: it is called for each ask, `respond(payload)`
 * answers it, and not calling `respond` is a worker that never answers. Every ask is recorded in
 * `requests` either way, so a test can also assert on what was asked while nothing answers. The
 * fake is returned as `chrome`, so a test can also take the extension away mid-flight.
 *
 * The other direction is `tell(msg)`: a message from the worker to this tab, answered by whatever
 * listener the overlay registered on `chrome.runtime.onMessage`, or by nobody.
 *
 * For the tests about one overlay replacing another: `keepHost` leaves the overlay's host in the
 * document, `before(window)` runs after the page has loaded and before the overlay is injected,
 * `inject()` injects the file again into the same window - which is the same world - and
 * `listeners` records every listener the overlay put on window and document while it started.
 */
export async function overlayWindow({
  url = 'http://localhost:5173/page?q=1#/route',
  sendMessage = null,
  config = null,
  storage = null,
  html = '<!doctype html><html><body></body></html>',
  keepHost = false,
  before = null,
  shared = null,
} = {}) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    // Gives the window requestAnimationFrame, which the overlay wants at start-up.
    pretendToBeVisual: true,
  });
  const { window } = dom;

  let api = null;
  window.__ccTest = (exposed) => { api = exposed; };

  const requests = [];
  /** A `chrome.*` event, its listeners in view so a test can fire it and see who still listens. */
  const event = () => {
    const listeners = [];
    return {
      listeners,
      addListener: (f) => { listeners.push(f); },
      removeListener: (f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
    };
  };
  /**
   * The extension, as much of it as the overlay touches. `lastError` is writable because that is
   * how Chrome reports a failed `sendMessage`: the callback runs with no answer and the error
   * sitting on `chrome.runtime`.
   */
  const chrome = {
    runtime: {
      id: 'testextensionid',
      lastError: undefined,
      sendMessage(msg, respond) {
        requests.push(msg);
        sendMessage?.(msg, respond);
      },
      onMessage: event(),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: event(),
    },
  };
  window.chrome = chrome;
  // Written into this world by the service worker immediately before the overlay is injected;
  // without it the overlay draws nothing at all.
  window.__ccConfig = {
    previewId: 'abcdef1234', origin: 'http://127.0.0.1:4317', repo: 'repo', slack: null,
    ...config,
  };
  if (shared) {
    shared.windows.add(window);
    Object.defineProperty(window, 'localStorage', { value: shared.area(window), configurable: true });
  }
  if (storage) {
    for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  }

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

  // What `chrome.scripting.executeScript` does, in the one way jsdom can do it: the file is run
  // in this window, with the config and the extension already there.
  const inject = () => {
    const script = window.document.createElement('script');
    script.textContent = SOURCE;
    window.document.body.appendChild(script);
    script.remove();
  };

  /**
   * Every listener the overlay hangs outside its own host, as it starts: these are what it has to
   * take down again when it leaves. Recorded on the two objects' own methods for the length of
   * the injection only, and handed on untouched. jsdom's selector engine registers listeners of
   * its own on the window the first time a selector is matched; those are jsdom's, not the
   * overlay's, and are told apart by where the call came from.
   */
  const listeners = [];
  const record = (target, where) => {
    const add = target.addEventListener;
    target.addEventListener = function recorded(type, fn, options) {
      const caller = new Error().stack.split('\n')[2] || '';
      if (!/[/\\]node_modules[/\\]/.test(caller)) listeners.push({ where, type, options });
      return add.call(this, type, fn, options);
    };
    return () => { delete target.addEventListener; };
  };

  await before?.(window);
  const unrecord = [record(window, 'window'), record(window.document, 'document')];
  try {
    inject();
  } finally {
    window.Element.prototype.attachShadow = attachShadow;
    for (const f of unrecord) f();
  }

  if (!api) throw new Error('overlay.js did not reach its __ccTest seam - it stopped early');

  // The overlay's own host is a <div> child of <body>. Left there it would be counted as a
  // sibling by :nth-of-type and swept up by "every element in the document", so the fixtures
  // get the document to themselves. Nothing the seam exposes reads `host`.
  if (!keepHost) window.document.getElementById('cc-overlay-host')?.remove();

  return {
    window,
    document: window.document,
    api,
    /** The overlay's own closed shadow root, the fake extension, and every message sent to it. */
    shadow,
    chrome,
    requests,
    listeners,
    inject,
    /** A message from the worker to this tab; resolves to the answer, or undefined for none. */
    tell: (msg) => new Promise((resolve) => {
      const keep = chrome.runtime.onMessage.listeners
        .map((f) => f(msg, { id: chrome.runtime.id }, resolve))
        .some(Boolean);
      if (!keep) resolve(undefined);
    }),
    /** Replaces the whole page. Returns the document for convenience. */
    setBody(html) {
      window.document.body.innerHTML = html;
      return window.document;
    },
    /** Takes the window's timers down with it, so the test process can exit. */
    close: () => { shared?.windows.delete(window); window.close(); },
  };
}

/**
 * Waits for something the overlay does asynchronously, and FAILS rather than hangs when it never
 * happens: the failures worth catching here are promises that never settle, and a test that waits
 * forever on one reports nothing at all. `within` is also an assertion - a deadline shorter than
 * the overlay's own timeout is how "it answered" is told apart from "it timed out".
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
