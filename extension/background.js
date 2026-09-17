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
const BRIDGE = 'http://127.0.0.1:4517';

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
  let value = null;
  try {
    const r = await fetch(`${BRIDGE}/resolve?origin=${encodeURIComponent(origin)}`);
    if (r.ok) value = await r.json();
  } catch {}
  resolved.set(origin, { at: Date.now(), value });
  return value;
}

/**
 * Put the overlay on a tab, if it belongs to a session.
 *
 * `#cc=` in the URL still wins: it is how one tab is pinned to a particular session while
 * several are running. Everything else is asked for.
 */
async function ensureBound(tabId, url) {
  await ready;
  const origin = originOf(url);
  // A page the bridge serves carries its own binding and loads its own overlay.
  if (!origin || origin === BRIDGE || disabled.has(origin)) return null;

  const fromHash = /[#&]cc=([a-f0-9]{8,})/.exec(url)?.[1] || null;
  let binding = bound.get(tabId);
  if (fromHash && binding?.previewId !== fromHash) binding = { previewId: fromHash, repo: '', origin };
  if (!binding || binding.origin !== origin) {
    const found = fromHash ? { previewId: fromHash, repo: '' } : await resolveOrigin(origin);
    if (!found) return null;
    binding = { previewId: found.previewId, repo: found.repo || '', origin, slack: found.slack || null };
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
    await chrome.scripting.executeScript({
      target,
      func: (cfg) => { window.__ccConfig = cfg; },
      args: [{ previewId: binding.previewId, origin: BRIDGE, repo: binding.repo, slack: binding.slack }],
    });
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['console-hook.js'] });
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
  try {
    await chrome.action.setBadgeText({ tabId, text: off ? 'off' : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6b6b76' });
    const b = bound.get(tabId);
    await chrome.action.setTitle({
      tabId,
      title: off
        ? `Comments off for ${origin}`
        : b || origin === BRIDGE
          ? `Commenting into ${b?.repo || 'the set-up session'}`
          : 'No Claude session is set up - run /preview in one',
    });
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
 * Send a comment on the page's behalf.
 *
 * This is the route that makes a deployed build work. A page on https://example.com fetching
 * http://127.0.0.1 is a local-network request, which Chrome 142 and later gate behind a
 * permission prompt; from here it is an ordinary extension fetch covered by host permissions.
 */
async function post(route, payload, timeout = 25000) {
  const r = await fetch(`${BRIDGE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? j : { error: j.error || `bridge ${r.status}` };
}

async function sendComment(payload) {
  if (!payload.previewId) return { error: 'this page is not bound to a session - reload it' };
  return post('/comment', payload);
}

/**
 * The Slack routes go through the worker for the same reason comments do - a page on an https
 * origin cannot reach loopback - and for one more: the bridge answers them only to this
 * extension, so what a page can ask for is exactly what the panel offers, and no more.
 */
async function slackDestinations(payload) {
  const r = await fetch(`${BRIDGE}/slack/destinations?q=${encodeURIComponent(payload?.q || '')}`, {
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? j : { error: j.error || `bridge ${r.status}` };
}

async function slackShare(payload) {
  if (!payload?.previewId) return { error: 'this page is not bound to a session - reload it' };
  // Two uploads and a post, each of which Slack may take its time over; the panel waits with it.
  return post('/slack/share', payload, 60000);
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
  try {
    const r = await fetch(`${BRIDGE}/slack/status`, { signal: AbortSignal.timeout(4000) });
    slackWas = r.ok ? await r.json() : { error: `bridge ${r.status}` };
  } catch {
    slackWas = { error: 'bridge is not running - run /preview in Claude Code' };
  }
  slackAt = Date.now();
  return slackWas;
}

/** Starting and ending a Slack connection from the toolbar menu. */
async function slackLogin() {
  slackWas = null;
  const j = await post('/slack/login', {}, 8000);
  if (j.url) await chrome.tabs.create({ url: j.url });
  return j;
}

async function slackLogout() {
  slackWas = null;
  return post('/slack/logout', {}, 8000);
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

  const slack = {
    slackDestinations, slackShare, slackStatus, slackLogin, slackLogout,
  }[msg?.type];
  if (slack) {
    slack(msg.payload)
      .then(respond)
      .catch((e) => respond({ error: String(e?.message || e) }));
    return true;
  }

  return false;
});
