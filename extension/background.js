/**
 * Service worker. Three jobs, all of which have to happen here rather than in the page:
 *
 * - It decides which Claude session a tab belongs to. That used to be a token in the address
 *   bar, which meant a second tab on the same app - or a link that opened one - was simply not
 *   part of the loop. The worker asks the bridge instead, on every page load.
 * - It injects the overlay, into this extension's isolated world. There the page's own scripts
 *   can neither read the binding nor reach this worker through the overlay, and the page's CSP
 *   does not apply to the injection.
 * - It sends the comments, and takes the screenshots. From Chrome 142 a page on an https origin
 *   cannot reach http://127.0.0.1 without a Local Network Access permission - the whole reason
 *   commenting on a deployed build works at all is that the request leaves from here, with the
 *   extension's host permissions, rather than from the page.
 */
// Spelled out again in the README, which cannot import it either; test/extension.test.mjs is what
// holds the two copies together.
const BRIDGE = 'http://127.0.0.1:4517';

// The version of the files this worker was started from. A constant rather than getManifest(),
// because after a browser restart Chrome can report the new manifest while this worker still runs
// the old script. scripts/ rewrites this line on release; test/ checks it against manifest.json.
const BUILD = '0.1.0';

/** Self-update state; see `maybeUpdate` below. Up here because `call` reads it on every request. */
let inFlight = 0; // requests to the bridge of this worker's own that have not come back
let updateWhenIdle = false; // an update waited for the last of them
let updating = null; // the one update check that may run at a time
let updateReady = null; // the version waiting on a comment being written, for the badge and the menu
let updateRetry = null;

/**
 * Which session each tab is talking to. Kept in memory rather than in the URL or in the page,
 * so a SPA that rewrites its own address bar cannot break the binding. Rebuilt from the bridge
 * on the next load if the worker is recycled.
 */
const bound = new Map(); // tabId -> { previewId, repo, origin }
const resolved = new Map(); // origin -> { at, value|null }
const RESOLVE_TTL = 15000;
const RESOLVE_MISS_TTL = 3000; // a miss is usually "bridge not up yet", so re-ask sooner

let disabled = new Set();
/**
 * Loaded before anything consults it. A worker is woken by the very page load it then has to
 * decide about, and deciding before the list arrived put the overlay on origins the user had
 * turned off.
 */
const ready = chrome.storage.local.get('off').then(
  (v) => { disabled = new Set(v?.off || []); },
  () => {},
);

const originOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
};

/** Who owns this origin, per the bridge. Cached briefly - this runs on every page load. */
async function resolveOrigin(origin) {
  const hit = resolved.get(origin);
  const ttl = hit?.value ? RESOLVE_TTL : RESOLVE_MISS_TTL;
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  // Through `call` like everything else, so this worker has exactly one place that decides what a
  // request to the bridge carries - and so the busiest route of all is the one that keeps the
  // daemon's record of this extension fresh. A failure comes back as `{ error }`, which is a miss
  // here and cached as one.
  const answer = await call(`/resolve?origin=${encodeURIComponent(origin)}`);
  const value = answer?.error ? null : answer;
  resolved.set(origin, { at: Date.now(), value });
  return value;
}

/**
 * Put the overlay on a tab, if it belongs to a session.
 *
 * The origin is the whole of the question: nothing in the address bar says which session a tab
 * belongs to, so every tab on an origin is bound the same way and a link that opens a second one
 * is part of the loop like the first.
 */
async function ensureBound(tabId, url) {
  await ready;
  const origin = originOf(url);
  if (!origin || disabled.has(origin)) return null;
  // The bridge serves the user's own files under /p/, and those are pages to comment on like any
  // other. Its remaining pages are notices it writes itself - /slack/callback says a login worked
  // - where there is nothing of the user's to point at.
  if (origin === BRIDGE && !new URL(url).pathname.startsWith('/p/')) return null;

  let binding = bound.get(tabId);
  if (!binding || binding.origin !== origin) {
    const found = await resolveOrigin(origin);
    if (!found) return null;
    binding = {
      previewId: found.previewId,
      repo: found.repo || '',
      origin,
      slack: found.slack || null,
    };
  } else {
    // Slack may have been connected - or dropped - since this tab was first bound, and the
    // panel decides whether to offer it at injection time. The lookup is cached, so this costs
    // a request every few page loads at most.
    const found = await resolveOrigin(origin);
    if (found) binding = { ...binding, slack: found.slack || null };
  }
  bound.set(tabId, binding);

  try {
    const target = { tabId, frameIds: [0] };
    // The binding and the overlay both go into the isolated world. Only the console hook runs
    // in the page world, because that is where the page's console is. Each guards against
    // running twice, since this happens on every completed load.
    // The first two have nothing to do with each other; the overlay needs both, since it reads
    // __ccConfig as it starts and listens for a hook that must already be there.
    await Promise.all([
      chrome.scripting.executeScript({
        target,
        func: (cfg) => { window.__ccConfig = cfg; },
        args: [{
          previewId: binding.previewId, origin: BRIDGE, repo: binding.repo, slack: binding.slack, build: BUILD,
        }],
      }),
      chrome.scripting.executeScript({ target, world: 'MAIN', files: ['console-hook.js'] }),
    ]);
    await chrome.scripting.executeScript({ target, files: ['overlay.js'] });
  } catch {
    // chrome:// pages, the web store, a tab that navigated away mid-flight. Not an error.
    return null;
  }
  paintBadge(tabId, origin);
  return binding;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.status || !tab?.url) return;
  // Chrome clears a tab's badge whenever it navigates, so "off" is painted again on every load -
  // including the loads that end early below, which are exactly the ones for an origin turned off.
  const origin = originOf(tab.url);
  if (origin) paintBadge(tabId, origin);
  if (changeInfo.status === 'complete') ensureBound(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => bound.delete(tabId));

/**
 * The overlay can appear on any page, so there has to be a way to say "not this one": the menu
 * under the toolbar icon (popup.html) writes the list of origins turned off to storage, and that
 * is all it does. The overlays already in open tabs follow storage themselves and hide at once;
 * here, every tab on an origin whose state changed gets its badge repainted, and a tab on an origin
 * turned back on gets an overlay if it was loaded while the origin was off.
 */
chrome.storage.onChanged.addListener(async (c, area) => {
  if (area !== 'local' || !c.off) return;
  const before = new Set(c.off.oldValue || []);
  disabled = new Set(c.off.newValue || []);
  const changed = new Set([...before, ...disabled].filter((o) => before.has(o) !== disabled.has(o)));
  if (!changed.size) return;
  for (const t of await chrome.tabs.query({})) {
    const origin = originOf(t.url || '');
    if (!t.id || !changed.has(origin)) continue;
    paintBadge(t.id, origin);
    if (!disabled.has(origin)) ensureBound(t.id, t.url);
  }
});

async function paintBadge(tabId, origin) {
  await ready;
  const off = disabled.has(origin);
  const b = bound.get(tabId);
  // An update waiting on a comment is said on every tab, since the comment may be in any of them;
  // 'off' still wins on its own origin, where it is what the icon has to say first.
  const up = !off && Boolean(updateReady);
  try {
    // Independent of each other, and this runs on every navigation and every tab switch.
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: off ? 'off' : up ? 'UP' : '' }),
      // The colours are constants and there is no badge to colour unless it says something.
      ...(off || up ? [chrome.action.setBadgeBackgroundColor({ tabId, color: off ? '#6b6b76' : '#6366f1' })] : []),
      chrome.action.setTitle({
        tabId,
        title: off
          ? `Comments off for ${origin}`
          : up
            ? `Update ${updateReady} ready - finish your comment and it installs itself`
            : b
              ? `Commenting into ${b.repo || 'the set-up session'}`
              : 'No Claude session is set up - run /connect in one',
      }),
    ]);
  } catch {}
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = originOf(tab?.url || '');
    if (origin) paintBadge(tabId, origin);
  } catch {}
});

/**
 * Every call to the bridge, from the one place. POST when there is a body, GET when there is not.
 *
 * Each one carries `x-cc-ext`, this extension's own id, which is how the daemon knows an extension
 * exists at all: `/connect` and `ctl.mjs status` say so, and `open.mjs` refuses to put a file in front
 * of a browser that has never had one. It is a sighting and nothing more - the bridge grants
 * nothing on the strength of this header - so there is no reason to send it selectively.
 *
 * This is the route that makes a deployed build work. A page on https://example.com fetching
 * http://127.0.0.1 is a local-network request, which Chrome 142 and later gate behind a
 * permission prompt; from here it is an ordinary extension fetch covered by host permissions.
 *
 * A failure always comes back as a value, never as a throw, and always with the bridge's own
 * words for it: one of these callers used to replace them with a status, which turned "that
 * channel is archived" into "bridge 502".
 */
async function call(route, { body, method, timeout = 25000 } = {}) {
  // Counted so an update never reloads this worker out from under a comment on its way.
  inFlight += 1;
  try {
    let r;
    try {
      r = await fetch(`${BRIDGE}${route}`, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: {
          'x-cc-ext': chrome.runtime.id,
          // Which version of this extension is running, so /connect can say whether it is current.
          'x-cc-ext-version': BUILD,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      /**
       * `code` is the part that crosses the process boundary intact. The sentence beside it is for
       * a person to read and may be reworded at any time; the popup and the panel decide what to
       * offer from the code alone, so that rewording one of these cannot silently change a menu.
       */
      return e?.name === 'TimeoutError'
        ? { error: 'the bridge did not answer in time', code: 'bridge_timeout' }
        : { error: 'the bridge is not answering - run /connect again in the session', code: 'bridge_unreachable' };
    }
    // The version sitting in the folder this extension is loaded from, as the bridge last wrote it.
    // Every response carries it, so a new version is noticed on the next page load.
    const latest = r.headers?.get?.('x-cc-ext-latest');
    if (latest && newer(latest, BUILD)) maybeUpdate(`the bridge has ${latest}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    // The bridge's own code where it sent one - a Slack failure says which - and its status, which
    // is how a daemon from older code is told apart: it answers a route it does not have with 404.
    return { error: j.error || `bridge ${r.status}`, code: j.code || 'bridge_error', status: r.status };
  } finally {
    inFlight -= 1;
    if (!inFlight && updateWhenIdle) {
      updateWhenIdle = false;
      maybeUpdate('the last bridge request finished');
    }
  }
}

/**
 * Hello, from a Chrome that has just started or an extension that has just been loaded.
 *
 * Nothing needs the answer; what it is for is the header the request carries. Otherwise a person
 * who installs the extension and runs /connect before visiting anything is told the extension is
 * NOT SEEN and sent to install the one they have just installed. One request, twice in a session.
 */
const sayHello = () => call('/health', { timeout: 4000 });
chrome.runtime.onStartup.addListener(sayHello);
chrome.runtime.onInstalled.addListener(sayHello);

/**
 * Pages that were open when this extension was installed or reloaded - by an update, most of the
 * time - get an overlay now rather than on their next load. A reload leaves each one holding the
 * old overlay's DOM with its script cut off from this worker, and injects nothing by itself; the
 * new overlay takes the old one's place (see the top of overlay.js). `bound` is empty after a
 * reload, so every http(s) tab is asked about, one at a time, so that a window full of tabs on one
 * origin asks the bridge once and the rest are answered from the cache.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  const reason = details?.reason;
  if (reason !== 'install' && reason !== 'update') return;
  if (reason === 'update') say(`now running ${BUILD} (was ${details.previousVersion || 'unknown'})`);
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch {}
  for (const t of tabs) {
    if (t.id && originOf(t.url || '')) await ensureBound(t.id, t.url);
  }
});

async function sendComment(payload) {
  if (!payload.previewId) return { error: 'this page is not bound to a session - reload it' };
  return call('/comment', { body: payload });
}

/** Where pins on a served HTML file moved after that file was edited. Same path as a comment. */
async function reanchor(payload) {
  if (!payload?.previewId) return { error: 'this page is not bound to a session - reload it' };
  return call('/reanchor', { body: payload });
}

/**
 * The Slack routes go through the worker for the same reason comments do - a page on an https
 * origin cannot reach loopback - and for one more: the bridge answers them only to this
 * extension, so what a page can ask for is exactly what the panel offers, and no more.
 */
async function slackDestinations(payload) {
  return call(`/slack/destinations?q=${encodeURIComponent(payload?.q || '')}`, { timeout: 15000 });
}

async function slackShare(payload) {
  if (!payload?.previewId) return { error: 'this page is not bound to a session - reload it' };
  // Two uploads and a post, each of which Slack may take its time over; the panel waits with it.
  return call('/slack/share', { body: payload, timeout: 60000 });
}

/**
 * Whether Slack is connected, for the toolbar menu and for a panel that was opened before the
 * connection existed. Cached briefly: a tab that has been open all day should not have to be
 * reloaded to see the button, and asking every time the panel opens is the price of that.
 */
let slackAt = 0;
let slackWas = null;
async function slackStatus() {
  if (slackWas && Date.now() - slackAt < 5000) return slackWas;
  slackWas = await call('/slack/status', { timeout: 4000 });
  slackAt = Date.now();
  return slackWas;
}

/**
 * Which session the pages in this browser report to, for the toolbar menu. Asked every time the
 * menu opens rather than cached: it is one loopback request, and the answer changes whenever
 * anybody runs /connect anywhere.
 */
const status = () => call('/status', { timeout: 4000 });

/** Starting and ending a Slack connection from the toolbar menu. */
async function slackLogin() {
  slackWas = null;
  const j = await call('/slack/login', { body: {}, timeout: 8000 });
  if (j.url) await chrome.tabs.create({ url: j.url });
  return j;
}

async function slackLogout() {
  slackWas = null;
  return call('/slack/logout', { body: {}, timeout: 8000 });
}

/**
 * The frame only. The ring round the anchor, the downscale and the encoding are done by the
 * overlay, which does all three for the capture path without the extension anyway.
 *
 * `captureVisibleTab` photographs whichever tab is showing in the window, not the tab that
 * asked. Switch tabs in the moment between Send and the shutter and it would attach someone's
 * inbox to a comment about a button - so the asking tab has to be the one showing, both before
 * the capture and after it, or there is no screenshot and the comment says why.
 */
async function captureTab(tab) {
  if (!tab?.id) return { error: 'no tab to capture' };
  const showing = async () => (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id === tab.id;
  const hidden = { error: 'the page was not the visible tab when the screenshot was taken' };
  if (!(await showing())) return hidden;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 95 });
  if (!(await showing())) return hidden;
  return dataUrl ? { dataUrl } : { error: 'captureVisibleTab returned nothing' };
}

// ---------------------------------------------------------------- updating itself
/**
 * The extension is loaded unpacked, once, from a folder the bridge daemon overwrites with each new
 * version of the plugin. Chrome does not notice new files there, so the worker reloads itself.
 *
 * What is running is `BUILD`, never `getManifest()`: after a browser restart Chrome has been seen
 * to report the new manifest while this worker still runs the old script. What is on disk is read
 * with a fetch of the extension's own files, which does see new files.
 *
 * A reload is a blunt instrument, so it is guarded on every side. The folder is read twice, five
 * seconds apart, and the manifest and this file must both carry the new version - the daemon
 * swaps the folder in a few renames, and a reload in between would load half of one version and
 * half of another, or nothing. No request of this worker's may be in flight: a comment on its way
 * would be cut off. No tab may hold a comment being written: the reload leaves its panel on screen
 * with nothing behind it. And a version gets two reloads, ten seconds apart at least, and then no
 * more: Chrome terminates an extension that reloads itself in a tight loop, and a folder that says
 * one version while Chrome keeps loading another would be exactly that loop.
 *
 * Checked when the worker starts - a new worker is often the first thing after the folder changed
 * - and whenever the bridge says the folder holds a newer version. No alarms: a worker with no
 * bridge traffic has nobody to update for.
 */
const UPDATE_SETTLE_MS = 5000;
const UPDATE_SPACING_MS = 10000;
const UPDATE_RETRY_MS = 15000;
const UPDATE_ATTEMPTS = 2;

/** One line per decision, so the update can be followed in the worker's console. */
const say = (line) => console.info(`[local-artifact] update: ${line}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `a` is a strictly later version than `b`. Anything unreadable counts as 0.0.0. */
function newer(a, b) {
  const parts = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    return m ? m.slice(1).map(Number) : [0, 0, 0];
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The version in the folder's manifest, or '' when it cannot be read - mid-sync, say. */
async function folderManifest() {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    return String((await r.json())?.version || '');
  } catch { return ''; }
}

/** The BUILD line of the background.js in the folder, or ''. */
async function folderWorker() {
  try {
    const r = await fetch(chrome.runtime.getURL('background.js'), { cache: 'no-store' });
    return /^const BUILD = '([^']*)';$/m.exec(await r.text())?.[1] || '';
  } catch { return ''; }
}

/**
 * The http(s) tabs whose overlay says it holds a comment being written or sent. A tab with no
 * overlay, or with one too old or too dead to answer, has nothing to lose and is not waited for.
 */
async function busyTabs() {
  let tabs = [];
  try { tabs = (await chrome.tabs.query({})).filter((t) => t.id && originOf(t.url || '')); } catch {}
  const answers = await Promise.all(tabs.map((t) => Promise.race([
    Promise.resolve()
      .then(() => chrome.tabs.sendMessage(t.id, { type: 'cc-busy?' }, { frameId: 0 }))
      .catch(() => null),
    sleep(1500).then(() => null),
  ])));
  return tabs.filter((_, i) => answers[i]?.busy === true);
}

/** The toolbar icon says an update is waiting on a comment - on every tab, and globally. */
async function showUpdateReady(target) {
  if (updateReady === target) return;
  updateReady = target;
  try {
    await chrome.action.setBadgeText({ text: target ? 'UP' : '' });
    if (target) await chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  } catch {}
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch {}
  for (const t of tabs) {
    const origin = originOf(t.url || '');
    if (t.id && origin) paintBadge(t.id, origin);
  }
}

/** Looks again later, so an update waiting on a comment does not wait for bridge traffic too. */
function retryUpdate() {
  if (updateRetry) return;
  updateRetry = setTimeout(() => { updateRetry = null; maybeUpdate('retrying'); }, UPDATE_RETRY_MS);
}

function maybeUpdate(why) {
  updating ||= checkForUpdate(why)
    .catch((e) => say(`check failed: ${e?.message || e}`))
    .finally(() => { updating = null; });
  return updating;
}

/** The loop guard's record: which version was last reloaded for, how often, and when. */
async function lastReload() {
  try { return (await chrome.storage.local.get('selfUpdate'))?.selfUpdate || null; } catch { return null; }
}
const attemptsFor = (last, target) => (last?.target === target ? Number(last.attempts) || 0 : 0);

async function checkForUpdate(why) {
  const first = await folderManifest();
  if (!newer(first, BUILD)) {
    say(`checked (${why}): running ${BUILD}, folder has ${first || 'no readable manifest'}`);
    await showUpdateReady(null);
    return;
  }
  // Every bridge response asks again while the folder is ahead; a version already given up on
  // is answered at once rather than after the wait below.
  const tried = attemptsFor(await lastReload(), first);
  if (tried >= UPDATE_ATTEMPTS) {
    await showUpdateReady(null);
    say(`gave up: ${tried} reloads did not bring up ${first}; running ${BUILD} - reload the extension by hand`);
    return;
  }
  await sleep(UPDATE_SETTLE_MS);
  const [manifest, worker] = await Promise.all([folderManifest(), folderWorker()]);
  if (manifest !== worker || !newer(manifest, BUILD)) {
    say(`skipped (${why}): folder is mid-sync - manifest ${manifest || '?'}, background.js ${worker || '?'}; running ${BUILD}`);
    return;
  }
  const target = manifest;
  if (inFlight) {
    updateWhenIdle = true;
    say(`deferred: ${inFlight} bridge request(s) in flight; ${BUILD} -> ${target}`);
    return;
  }
  const busy = await busyTabs();
  if (busy.length) {
    await showUpdateReady(target);
    retryUpdate();
    say(`deferred: a comment is being written in ${busy.length} tab(s); ${BUILD} -> ${target}`);
    return;
  }
  const last = await lastReload();
  const now = Date.now();
  const attempts = attemptsFor(last, target);
  if (attempts >= UPDATE_ATTEMPTS) {
    await showUpdateReady(null);
    say(`gave up: ${attempts} reloads did not bring up ${target}; running ${BUILD} - reload the extension by hand`);
    return;
  }
  if (attempts && now - (Number(last.lastAt) || 0) < UPDATE_SPACING_MS) {
    retryUpdate();
    say(`deferred: the last reload for ${target} was under ${UPDATE_SPACING_MS / 1000} s ago; running ${BUILD}`);
    return;
  }
  // Asked again: the tabs took their time answering, and a comment may have left meanwhile.
  if (inFlight) {
    updateWhenIdle = true;
    say(`deferred: ${inFlight} bridge request(s) in flight; ${BUILD} -> ${target}`);
    return;
  }
  try {
    await chrome.storage.local.set({ selfUpdate: { target, attempts: attempts + 1, lastAt: now } });
  } catch {}
  say(`reloading: ${BUILD} -> ${target} (attempt ${attempts + 1} of ${UPDATE_ATTEMPTS})`);
  chrome.runtime.reload();
}

/** For the toolbar menu, which shows the version for anyone asked to report a problem. */
const version = async () => ({ build: BUILD, ready: updateReady });

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;

  // Answering ping here, rather than in a content script, is what makes it a real liveness
  // check: it only succeeds if the worker is actually reachable.
  if (msg?.type === 'ping') { respond({ ok: true }); return false; }

  if (msg?.type === 'capture') {
    captureTab(sender.tab)
      .then(respond)
      .catch((e) => respond({ error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === 'comment') {
    sendComment(msg.payload || {})
      .then(respond)
      .catch((e) => respond({ error: String(e?.message || e) }));
    return true;
  }

  const ask = {
    slackDestinations, slackShare, slackStatus, slackLogin, slackLogout, status, reanchor, version,
  }[msg?.type];
  if (ask) {
    ask(msg.payload)
      .then(respond)
      .catch((e) => respond({ error: String(e?.message || e) }));
    return true;
  }

  return false;
});

// A worker that has just started is often the first thing to run after the folder changed.
maybeUpdate('worker started');
