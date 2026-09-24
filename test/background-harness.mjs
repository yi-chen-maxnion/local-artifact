/**
 * Runs the real, unmodified extension/background.js in a `vm` context, against a fake `chrome`,
 * a fake `fetch` and a clock the test moves by hand.
 *
 * The worker is a classic script with no module system, like the overlay (see test/dom.mjs), so
 * the honest test is again to execute the file Chrome executes. What it reaches outside itself is
 * all here and all in memory: the bridge is a function the test supplies, the folder the extension
 * is loaded from is a map of file names to text (which is what a `chrome-extension://` fetch reads,
 * and which the test rewrites to play the daemon syncing a new version), and the tabs are plain
 * objects whose overlay, if they have one, is a function answering the worker's messages.
 *
 * Time is the clock's alone. The worker waits seconds between reading the folder twice and minutes
 * between retries, and a test that slept through those for real would take longer than the rest
 * of the suite; so `setTimeout` and `Date.now` in the worker's world are the clock's, and nothing
 * happens until `advance` says so. Nothing under extension/ knows it is being tested.
 */
import fs from 'node:fs';
import vm from 'node:vm';

export const WORKER_SRC = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const BUILD_LINE = /^const BUILD = '([^']*)';$/m;

/** The version the worker under test was built as - whatever the release script last wrote. */
export const RUNNING = BUILD_LINE.exec(WORKER_SRC)?.[1];

/** One patch release on from `v`. */
export const bump = (v) => v.replace(/(\d+)$/, (n) => String(Number(n) + 1));

/**
 * A copy of the extension's folder as the daemon would write it for version `manifest`, with the
 * worker's own BUILD line saying `worker` - which differs from the manifest only while a sync is
 * half done.
 */
export function folder(manifest, worker = manifest) {
  return {
    'manifest.json': JSON.stringify({ manifest_version: 3, version: manifest }),
    'background.js': WORKER_SRC.replace(BUILD_LINE, `const BUILD = '${worker}';`),
  };
}

/** Lets every promise chain started so far run to its end, or to its next timer. */
export async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/** Time for the worker: timers run only when a test advances it. Shared between workers on purpose. */
export class Clock {
  now = 1_700_000_000_000;
  timers = [];
  seq = 0;

  setTimeout = (fn, ms = 0, ...args) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now + Math.max(0, Number(ms) || 0), fn: () => fn(...args) });
    return id;
  };

  clearTimeout = (id) => { this.timers = this.timers.filter((t) => t.id !== id); };

  /** Moves time forward, running each timer that falls due at its own moment, in order. */
  async advance(ms) {
    const end = this.now + ms;
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** A `chrome.*` event: listeners are kept so a test can fire it, and see who is still listening. */
function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (f) => { listeners.push(f); },
    removeListener: (f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
    hasListener: (f) => listeners.includes(f),
    fire: (...args) => listeners.map((f) => f(...args)),
  };
}

const EXT_ID = 'fakeextensionid';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;
const BRIDGE = 'http://127.0.0.1:4517';

/**
 * A worker, started. Everything it does lands in the returned record.
 *
 * - `disk`: the folder it is loaded from; replace entries on `w.disk` to change it under the worker.
 * - `latest`: what the bridge puts in `x-cc-ext-latest` on every response; `null` for no header.
 * - `bridge(route, init)`: answers a request with `{ status, body }`; may return a promise that is
 *   held open, which is a request in flight. Defaults to `{}` for everything and a binding for
 *   `/resolve`.
 * - `tabs`: `{ id, url, overlay }`, where `overlay(msg)` is what the tab's content script answers,
 *   and a tab without one has nothing listening - the message fails the way Chrome fails it.
 * - `store` and `clock` are shared between workers to play one that reloads into the next.
 */
export async function startWorker({
  disk = folder(RUNNING),
  latest = null,
  bridge = null,
  tabs = [],
  store = {},
  clock = new Clock(),
} = {}) {
  const w = {
    disk: { ...disk },
    latest,
    tabs,
    store,
    clock,
    requests: [], // to the bridge: { route, method, headers, body }
    folderReads: [], // chrome-extension:// fetches, by file name
    reloads: [], // the clock's time at each chrome.runtime.reload()
    injections: [], // chrome.scripting.executeScript calls
    badges: [], // setBadgeText calls
    titles: [], // setTitle calls
    logs: [], // console lines
    messages: [], // chrome.tabs.sendMessage calls: { tabId, msg }
  };

  const answer = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  const defaultBridge = (route) => (route.startsWith('/resolve')
    ? { status: 200, body: { previewId: 'p1', repo: 'repo' } }
    : { status: 200, body: {} });

  async function fakeFetch(url, init = {}) {
    url = String(url);
    if (url.startsWith(EXT_ORIGIN)) {
      const name = url.slice(EXT_ORIGIN.length);
      w.folderReads.push(name);
      // A file missing mid-sync fails like a fetch of a missing extension file does.
      if (!(name in w.disk)) throw new TypeError('Failed to fetch');
      return answer(200, w.disk[name]);
    }
    if (url.startsWith(BRIDGE)) {
      const route = url.slice(BRIDGE.length);
      w.requests.push({ route, method: init.method, headers: { ...init.headers }, body: init.body });
      const out = await (bridge || defaultBridge)(route, init);
      const headers = w.latest ? { 'x-cc-ext-latest': w.latest } : {};
      return answer(out?.status ?? 200, out?.body ?? {}, headers);
    }
    throw new TypeError(`unexpected fetch ${url}`);
  }

  const tabById = (id) => w.tabs.find((t) => t.id === id);
  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p) => EXT_ORIGIN + p,
      // What Chrome can report after a restart: the folder's manifest, not the running code's. A
      // worker that trusted it would think itself up to date and never reload.
      getManifest: () => JSON.parse(w.disk['manifest.json'] || '{}'),
      reload: () => { w.reloads.push(clock.now); },
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
    },
    tabs: {
      query: async () => w.tabs.map(({ id, url, windowId = 1, active = false }) => ({ id, url, windowId, active })),
      get: async (id) => tabById(id),
      create: async () => ({}),
      sendMessage: async (tabId, msg) => {
        w.messages.push({ tabId, msg });
        const t = tabById(tabId);
        if (!t?.overlay) throw new Error('Could not establish connection. Receiving end does not exist.');
        return t.overlay(msg);
      },
      captureVisibleTab: async () => null,
      onUpdated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    scripting: {
      executeScript: async (inj) => { w.injections.push(inj); return []; },
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = keys == null ? Object.keys(store) : [].concat(keys);
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set: async (o) => { Object.assign(store, structuredClone(o)); },
      },
      onChanged: event(),
    },
    action: {
      setBadgeText: async (o) => { w.badges.push(o); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async (o) => { w.titles.push(o); },
    },
  };
  w.chrome = chrome;

  const say = (...a) => { w.logs.push(a.map(String).join(' ')); };
  const context = vm.createContext({
    chrome,
    fetch: fakeFetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: class extends Date { static now() { return clock.now; } },
    AbortSignal: { timeout: () => undefined },
    URL,
    Headers,
    console: { log: say, info: say, warn: say, error: say, debug: say },
  });
  vm.runInContext(WORKER_SRC, context, { filename: 'extension/background.js' });

  /** A message from one of the extension's own pages, answered the way the worker answers it. */
  w.ask = (type, payload) => new Promise((resolve) => {
    const keep = chrome.runtime.onMessage.listeners
      .map((f) => f({ type, payload }, { id: EXT_ID }, (v) => resolve(v)))
      .some(Boolean);
    // Nobody kept the channel open: Chrome closes it, and an answer given already stands.
    if (!keep) resolve(undefined);
  });
  w.advance = (ms) => clock.advance(ms);
  w.lastBadge = () => w.badges.filter((b) => b.tabId === undefined).at(-1)?.text;
  await flush();
  return w;
}
