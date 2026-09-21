import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  HOST, PORT, ORIGIN, PING_MS, ROOT, SESSION_KEY, STATE_FILE, TOKEN_FILE,
  codeBuild, pidAlive, rateLimiter, readToken, shortId, writeFileAtomic,
} from '../lib/common.mjs';
import { previewHash } from '../lib/format.mjs';
import { Store, decodeShot } from './store.mjs';
import { contentType, decodeSegments, isFile, kindOf, readIfFile, safeJoin } from './serve.mjs';
import { gonePage, slackPage, wrapperPage } from './wrapper.mjs';
import * as slack from './slack.mjs';

const MAX_BODY = 12 * 1024 * 1024; // a downscaled JPEG is ~150KB; this is slack, not a target
const IDLE_EXIT_MS = 5 * 60 * 1000;

/**
 * Identifies this daemon process. A monitor outlives daemon restarts, so it cannot rely on
 * the seq counter alone: if a restarted daemon hands out numbers a reconnecting monitor has
 * already seen, every one of those events is silently discarded as a duplicate. The monitor
 * resets its watermark whenever this value changes.
 */
const INSTANCE = shortId(6);

/**
 * What separates this machine's own callers - preview, ctl, the monitor - from a web page.
 * A page in the browser can reach this port, and a plain `text/plain` POST from one is sent
 * without any CORS preflight; what it cannot do is read a 0600 file. So the routes that
 * register sessions, open files and stream comments require this token, which is written to
 * TOKEN_FILE once the port is ours.
 */
const TOKEN = shortId(16);
const CONTROL = new Set(['/register', '/preview', '/claim', '/events']);
const BUILD = codeBuild(ROOT);

/**
 * The only Host headers this daemon answers to. Anything else is a name that resolves to
 * loopback without being loopback - DNS rebinding - which would make an attacker's page
 * same-origin with every route here.
 */
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const sessions = new Map(); // key -> { key, pid, cwd, repo, at }
// previewId -> { sessionKey, sessionPid, target, kind, root, entry, external, origin?, claimed?, claimedAt? }
const previews = new Map();
const clients = new Map(); // key -> Set<res>
const store = new Store();
let seq = 0;
let lastActivity = Date.now();
const startedAt = Date.now();

/**
 * How long after a monitor was last connected a comment is still taken on trust.
 *
 * A monitor drops and comes back for ordinary reasons - the daemon restarting, a laptop waking,
 * a VPN flip - and the replay buffer hands it whatever it missed, so refusing during those few
 * seconds would be wrong. Beyond the window, nothing is coming back for it.
 */
const LISTEN_GRACE_MS = Number(process.env.LOCAL_ARTIFACT_LISTEN_GRACE_MS ?? 60 * 1000);
/**
 * How many comments one session takes in a minute, and what a page is told past that.
 *
 * The threat is a page - hostile, or merely a buggy loop - filling a session's context with
 * notifications. The monitor used to hold this limit, which meant it could only ever drop
 * comments the bridge had already answered 200 for: the panel had closed and the page had drawn
 * a numbered pin, so the user was told a comment had arrived that nothing would ever read. Only
 * the daemon can give the answer back to the person who pressed Send, so it refuses here.
 *
 * Per session, because the thing being protected is one Claude session's attention. A page the
 * bridge accepts posts from can therefore spend that session's budget and keep the user from
 * commenting for the rest of the minute - inherent to any limiter, and the lesser harm.
 *
 * The max is env-configurable purely so a test can set it to 2 rather than send 31 requests.
 */
const COMMENT_RATE_MAX = Number(process.env.LOCAL_ARTIFACT_COMMENT_RATE_MAX ?? 30);
const COMMENT_RATE_WINDOW_MS = 60 * 1000;
const commentRate = new Map(); // sessionKey -> limiter, dropped with the session
/**
 * Which session an otherwise unbound page belongs to.
 *
 * The binding used to live in the address bar: `/preview` minted a token, put it in the URL,
 * and a tab without it was simply not part of the loop - which meant a second tab on the same
 * app, or a link that opened one, was dead. The session owns the browser instead: `/preview` is
 * setup, and every page the extension can reach asks who it belongs to.
 *
 * Most recent setup wins. With one session - the normal case - there is nothing to decide; with
 * several, the tie-break has to be something the user did rather than something arbitrary, and
 * the overlay names the repo it is sending to so the answer is visible rather than guessed.
 */
let primaryKey = null;

function send(res, code, type, body, headers = {}) {
  res.writeHead(code, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
const html = (res, code, body) => send(res, code, 'text/html; charset=utf-8', body);

/**
 * A Slack failure as the extension receives it. The message is the prescription a person reads
 * (see `explain` in slack.mjs) and it gets reworded; `code` is what the panel and the toolbar
 * menu may branch on, and `auth` says the connection itself is broken rather than the request.
 */
const slackError = (e) => ({
  error: e.message,
  code: e.code || 'slack_error',
  ...(e.auth ? { auth: true } : {}),
});

const isExtension = (origin) => /^chrome-extension:\/\//i.test(origin || '');
const hasToken = (req) => req.headers['x-cc-token'] === TOKEN;

/**
 * Routes a web page may not call at all, whatever page it is.
 *
 * What they hand back is the user's, not a page's: which session owns this browser, and where
 * in Slack that person can post. A web Origin is refused outright and never gets CORS headers,
 * and so is anything the browser marks as coming from a web context - an `<img>` pointed here,
 * or a page the bridge itself serves. The extension's service worker sends neither: its fetches
 * carry `Origin: chrome-extension://…`, which a page cannot forge.
 */
function extensionOnly(req) {
  const from = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  return from ? isExtension(from) : !(site && site !== 'none');
}

function readBody(req) {
  // A JSON content type is what forces a cross-origin page through a preflight, which this
  // server never grants outside /comment. Accepting `text/plain` would let any page post here blind.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return Promise.reject(Object.assign(new Error('content-type must be application/json'), { status: 415 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function saveState() {
  try {
    writeFileAtomic(STATE_FILE, JSON.stringify({
      seq, primaryKey, previews: [...previews.entries()], counters: store.counters(),
    }));
  } catch {}
}

function loadState() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  seq = Number(raw.seq) || 0;
  primaryKey = raw.primaryKey || null;
  for (const [id, pv] of raw.previews || []) {
    // Drop what can no longer work: the owning session is gone, or the file was deleted.
    if (!pidAlive(pv.sessionPid)) continue;
    if (!pv.external && !isFile(pv.entry)) continue;
    // Minted before ids were per origin, these carry only their target. Given their origin once,
    // here, nothing downstream has to know the old shape existed.
    if (pv.external && !pv.origin) pv.origin = originOf(pv.target);
    previews.set(id, pv);
  }
  store.restoreCounters(raw.counters, (id) => previews.has(id));
}

/** How a page is identified for numbering: path and query, matching the overlay's own key. */
function pageKey(u) {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch { return ''; }
}

/** The origin of an http(s) target, or null for anything else. */
function originOf(target) {
  try {
    const u = new URL(target);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}

/**
 * One preview per (session, origin) and per (session, file), created on demand and then reused -
 * so a page's markers, which live in `localStorage` under the preview id, survive both a second
 * `/preview` and a daemon restart. Minting a fresh id per invocation silently orphaned every pin.
 */
function previewFor(sessionKey, match, init) {
  for (const [previewId, pv] of previews) {
    if (pv.sessionKey === sessionKey && match(pv)) return { previewId, pv, created: false };
  }
  const s = sessions.get(sessionKey);
  if (!s) return null;
  const previewId = shortId(8);
  const pv = { sessionKey, sessionPid: s.pid, ...init };
  previews.set(previewId, pv);
  return { previewId, pv, created: true };
}

const originPreview = (sessionKey, origin) => previewFor(sessionKey, (pv) => pv.origin === origin, {
  kind: 'origin', target: origin, origin, external: true, root: null, entry: null,
});

/** The session a page on this origin belongs to, or null if nothing is set up. */
function ownerOf(origin) {
  // An origin that was explicitly opened with /preview stays with the session that opened it,
  // whatever has been set up since - and where several live sessions have opened it, with the one
  // that opened it last. Insertion order would hand it to whoever got there first and never let go,
  // so a second session running /preview on the same app would be told it owns a browser it does not.
  let best = null;
  for (const pv of previews.values()) {
    if (pv.origin !== origin || !pv.claimed || !sessions.has(pv.sessionKey)) continue;
    // Claimed by a daemon older than claimedAt: outranked by any claim that carries a time.
    if (!best || (pv.claimedAt || 0) > (best.claimedAt || 0)) best = pv;
  }
  if (best) return best.sessionKey;
  return sessions.has(primaryKey) ? primaryKey : null;
}

/**
 * The setup gesture, whatever made it: from now on this session owns the browser.
 *
 * It claims no origin of its own - `ownerOf` falls back to it only for origins nobody opened
 * explicitly, which is precisely the "any page you open" case the extension relies on.
 */
function claimBrowser(key) {
  primaryKey = key;
  saveState();
}

function pruneSessions() {
  let changed = false;
  for (const [key, s] of sessions) {
    if (pidAlive(s.pid)) continue;
    changed = true;
    sessions.delete(key);
    for (const [id, pv] of previews) {
      if (pv.sessionKey !== key) continue;
      previews.delete(id);
      store.dropCounter(id); // or it is written back to disk forever
    }
    for (const res of clients.get(key) || []) { try { res.end(); } catch {} }
    clients.delete(key);
    commentRate.delete(key);
    store.forget(key);
  }
  if (!changed) return;
  // The browser does not go unowned because its owner ended: it passes to whichever remaining
  // session registered most recently.
  if (!sessions.has(primaryKey)) {
    primaryKey = [...sessions.values()].sort((a, b) => b.at - a.at)[0]?.key || null;
  }
  saveState();
}

/**
 * Is anything going to read this?
 *
 * A comment is written into a replay buffer and pushed to whatever monitors are streaming. With
 * no monitor - a session where `/preview` was never run, one whose monitor never armed, one that
 * has been closed - the buffer is where the comment stops, and the page was being told it had
 * been delivered. A comment nobody receives is a failure and has to read as one, while it is
 * still on screen and can be sent somewhere else.
 */
function listening(sessionKey) {
  if ((clients.get(sessionKey)?.size || 0) > 0) return true;
  // A daemon that has only just started counts as within the window: its monitors are
  // reconnecting right now, and they have not had the chance to be seen yet.
  const seen = Math.max(sessions.get(sessionKey)?.lastStream || 0, startedAt);
  return Date.now() - seen < LISTEN_GRACE_MS;
}

function allowComment(sessionKey) {
  let allow = commentRate.get(sessionKey);
  if (!allow) commentRate.set(sessionKey, allow = rateLimiter(COMMENT_RATE_MAX, COMMENT_RATE_WINDOW_MS));
  return allow();
}

function broadcast(sessionKey, payload) {
  store.push(sessionKey, payload);
  const line = `event: comment\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients.get(sessionKey) || []) {
    try { res.write(line); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  // The extension asks /resolve on every page load; that is browsing, not use of the bridge,
  // and must not keep an otherwise idle daemon alive.
  if (p !== '/resolve') lastActivity = Date.now();

  try {
    if (!HOSTS.has(req.headers.host)) return json(res, 421, { error: 'unexpected host' });
    if (CONTROL.has(p) && !hasToken(req)) return json(res, 401, { error: 'control token required' });

    if (p === '/health') {
      // Anyone may learn the bridge is up; only a caller holding the token learns what is in it.
      if (!hasToken(req)) return json(res, 200, { ok: true, instance: INSTANCE });
      pruneSessions();
      return json(res, 200, {
        ok: true, pid: process.pid, origin: ORIGIN, instance: INSTANCE, root: ROOT, build: BUILD,
        primary: primaryKey, slack: slack.status(),
        sessions: [...sessions.values()].map((s) => ({ ...s, clients: clients.get(s.key)?.size || 0 })),
        previews: [...previews.entries()].map(([id, v]) => ({
          id, sessionKey: v.sessionKey, target: v.target, kind: v.kind,
          origin: v.origin || undefined, claimed: v.claimed || undefined,
        })),
      });
    }

    if (p === '/register' && req.method === 'POST') {
      const b = await readBody(req);
      const pid = Number(b.pid);
      if (!SESSION_KEY.test(String(b.key)) || !pidAlive(pid)) {
        return json(res, 400, { error: 'a valid session key and a live pid are required' });
      }
      // Merged, not replaced. A monitor reconnects by registering and only then reopening /events,
      // so a fresh object here would drop `lastStream` - and void the grace window in exactly the
      // gap it was written for.
      sessions.set(b.key, {
        ...sessions.get(b.key),
        key: b.key, pid, cwd: String(b.cwd || ''), repo: String(b.repo || ''), at: Date.now(),
      });
      // A monitor reconnecting is not a setup gesture, so it does not steal the browser from
      // another session - but if nothing holds it, someone has to.
      if (!sessions.has(primaryKey)) primaryKey = b.key;
      return json(res, 200, { ok: true, previews: [...previews.values()].filter((v) => v.sessionKey === b.key).length });
    }

    /**
     * Setup with nothing to open: `/preview` without a target. With the extension installed that
     * is all most sessions need, since every page already carries the button and only has to be
     * told whose session it reports to.
     */
    if (p === '/claim' && req.method === 'POST') {
      const b = await readBody(req);
      if (!sessions.has(b.key)) return json(res, 409, { error: 'session not registered' });
      claimBrowser(b.key);
      return json(res, 200, { ok: true, primary: primaryKey });
    }

    if (p === '/preview' && req.method === 'POST') {
      const b = await readBody(req);
      const s = sessions.get(b.key);
      if (!s) return json(res, 409, { error: 'session not registered' });
      const target = String(b.target || '');
      const origin = originOf(target);
      let found;
      if (origin) {
        // Reused, not re-minted. The id is the namespace this origin's markers live in.
        found = originPreview(b.key, origin);
        found.pv.claimed = true; // an explicit open outranks "whoever set up last"
        found.pv.claimedAt = Date.now(); // and a later explicit open outranks an earlier one
        found.pv.target = target;
      } else {
        const entry = path.resolve(target);
        if (!isFile(entry)) return json(res, 404, { error: `not a file: ${entry}` });
        found = previewFor(b.key, (pv) => pv.entry === entry, {
          kind: kindOf(entry), target, entry, root: path.dirname(entry), external: false,
        });
      }
      found.pv.sessionPid = s.pid;
      // Opening a target IS a setup gesture too: it says which session the browser belongs to.
      claimBrowser(b.key);
      const { previewId, pv } = found;
      const open = pv.external
        ? previewHash(target, previewId)
        : `${ORIGIN}/p/${previewId}/`;
      return json(res, 200, { previewId, url: open, kind: pv.kind, external: pv.external, origin: pv.origin });
    }

    /**
     * Who does a page on this origin belong to? Asked by the extension's service worker on
     * every page load, and the reason a tab no longer needs a token in its address bar.
     *
     * Only the extension may ask - the answer is a routing token for the user's session. A web
     * Origin is refused outright and never gets CORS headers, and so is any request a browser
     * marks as coming from a web context (Sec-Fetch-Site): an `<img>` pointed here, or a page
     * the bridge itself serves.
     */
    if (p === '/resolve') {
      if (!extensionOnly(req)) return json(res, 403, { error: 'only the extension may resolve a binding' });
      pruneSessions();
      const origin = originOf(url.searchParams.get('origin') || '');
      if (!origin) return json(res, 400, { error: 'origin required' });
      // The bridge's own origin is answered like any other: the pages it serves used to carry a
      // preview id in the markup, and now the extension asks about them the way it asks about a
      // dev server. Numbering and pins stay per page, since pageKey holds the `/p/<id>/` path.
      // Whether the panel offers to post to Slack at all, and under whose name. Never a token.
      // Asked for only once there is an answer to attach it to: this route runs on every page load.
      const slackFor = () => {
        const s = slack.status();
        return s.connected ? { connected: true, user: s.user } : { connected: false };
      };
      /**
       * A tab that carries `#cc=` is already bound and is asking only what goes with that id: the
       * tab /preview opened, and the way one tab is pinned to a session while several are running.
       * Answering with whoever claimed this origin last would label it with the wrong session's
       * repo, so an id that is not live on this origin is a miss rather than a fallback.
       */
      const wanted = url.searchParams.get('preview');
      if (wanted) {
        const pv = previews.get(wanted);
        if (!pv || pv.origin !== origin || !sessions.has(pv.sessionKey)) {
          return json(res, 404, { error: 'no live preview with that id on this origin' });
        }
        return json(res, 200, { previewId: wanted, repo: sessions.get(pv.sessionKey).repo, slack: slackFor() });
      }
      const key = ownerOf(origin);
      const found = key && originPreview(key, origin);
      if (!found) {
        return json(res, 404, {
          error: 'no session is set up',
          hint: 'run /preview in the Claude session that should receive comments',
        });
      }
      if (found.created) saveState();
      return json(res, 200, {
        previewId: found.previewId,
        repo: sessions.get(key).repo,
        slack: slackFor(),
      });
    }

    /**
     * Connecting Slack. Both ends of the OAuth flow live here because the token belongs to this
     * daemon, and both the session (`/slack login`) and the extension's toolbar menu may start
     * one: setting the plugin up should not mean learning a command for the one step that is not
     * on the page. Starting a login is not itself an action on anyone's Slack - it opens a page
     * the person has to approve, and the token it yields lands here and nowhere else - so the
     * extension-only rule is guard enough, and a web page is still refused.
     *
     * `/slack/callback` is where Slack sends the browser back and cannot carry any of this; what
     * guards it is the single-use `state` minted by the login it belongs to.
     */
    if (p === '/slack/status' || p === '/slack/login' || p === '/slack/logout') {
      if (!extensionOnly(req)) return json(res, 403, { error: 'not available to a web page' });
      if (p === '/slack/status') {
        const s = slack.status();
        return json(res, 200, { configured: s.configured, connected: s.connected, user: s.user, team: s.team });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      if (p === '/slack/logout') {
        await slack.logout();
        return json(res, 200, { ok: true });
      }
      return json(res, 200, slack.startLogin());
    }

    if (p === '/slack/callback') {
      try {
        return html(res, 200, slackPage(true, await slack.finishLogin(
          url.searchParams.get('code'), url.searchParams.get('state'),
        )));
      } catch (e) {
        // A person is looking at this in a browser, so explain it rather than return raw JSON.
        return html(res, 400, slackPage(false, e.message));
      }
    }

    if (p === '/slack/destinations') {
      if (!extensionOnly(req)) return json(res, 403, { error: 'only the extension may list Slack destinations' });
      try {
        return json(res, 200, await slack.destinations(url.searchParams.get('q') || ''));
      } catch (e) {
        return json(res, e.status || 502, slackError(e));
      }
    }

    /**
     * A comment on its way to Slack instead of to the session. It deliberately shares nothing
     * with `/comment` past this point: no sequence number, no marker, no replay buffer and no
     * event - the session is not told, because the user chose the other button.
     */
    if (p === '/slack/share' && req.method === 'POST') {
      if (!extensionOnly(req)) return json(res, 403, { error: 'only the extension may post to Slack' });
      const b = await readBody(req);
      const pv = previews.get(b.previewId);
      // The binding is what says this came from a page the user set up, not from anywhere else
      // that can reach the port.
      if (!pv) return json(res, 404, { error: 'unknown preview' });
      // Unlike a comment to the session, this one may be empty: a screenshot of the thing, with
      // the page and the element named under it, is often the whole of what someone wants to
      // show a colleague.
      const text = String(b.comment || '').slice(0, 8000).trim();
      if (!slack.allowShare()) return json(res, 429, { error: 'too many Slack posts in a minute' });
      const payload = {
        repo: sessions.get(pv.sessionKey)?.repo || '',
        comment: text,
        page: b.page || {},
        anchor: b.anchor || {},
        console: b.console || [],
      };
      try {
        const out = await slack.share({ dest: b.dest || {}, payload, shot: decodeShot(b.screenshot) });
        return json(res, 200, { ok: true, label: out.label });
      } catch (e) {
        slack.shareFailed(e.message);
        return json(res, e.status || 502, slackError(e));
      }
    }

    if (p.startsWith('/p/')) {
      const [, , previewId, ...rest] = p.split('/');
      const pv = previews.get(previewId);
      // A person is looking at this in a browser, so explain it rather than return raw JSON.
      if (!pv || pv.external) return html(res, 404, gonePage(previewId));
      // Relative asset URLs only resolve under the id with its trailing slash.
      if (!rest.length) return send(res, 301, 'text/plain; charset=utf-8', '', { location: `/p/${previewId}/` });
      const rel = decodeSegments(rest);
      if (rel === null) return json(res, 400, { error: 'malformed path' });

      if (!rel) {
        // A page of the user's own is served as it is on disk, byte for byte. The extension puts
        // the overlay on it, as it does on every other origin, so nothing here rewrites it - and
        // what the person reviews is exactly the file they were shown.
        if (pv.kind === 'html') {
          const buf = readIfFile(pv.entry);
          if (!buf) return html(res, 404, gonePage(previewId));
          return send(res, 200, contentType(pv.entry), buf);
        }
        // A PDF or an image is linked from the wrapper page, not read into it.
        const linked = pv.kind === 'pdf' || pv.kind === 'image';
        const text = linked ? '' : readIfFile(pv.entry)?.toString('utf8');
        if (linked ? !isFile(pv.entry) : text == null) return html(res, 404, gonePage(previewId));
        const name = path.basename(pv.entry);
        return html(res, 200, wrapperPage({
          kind: pv.kind, title: name, text, src: `./__target/${encodeURIComponent(name)}`,
        }));
      }

      // A wrapper page names its target under __target/; an HTML page's own paths are left as they are.
      const asset = safeJoin(pv.root, pv.kind === 'html' ? rel : rel.replace(/^__target\//, ''));
      const buf = asset && readIfFile(asset);
      if (!buf) return json(res, 404, { error: 'not found' });
      return send(res, 200, contentType(asset), buf);
    }

    if (p === '/comment') {
      /**
       * CORS, scoped to /comment alone - the one route a page on another origin calls: a
       * bookmarklet on a dev server. A page served by this bridge is same-origin and the
       * extension is exempt, so neither needs any of this.
       *
       * Deliberately NOT applied to every route. The header goes on error responses too, so the
       * page can read a 403 and say what happened instead of the browser's opaque network error.
       */
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
      }
      if (req.method === 'OPTIONS') {
        return send(res, 204, 'text/plain; charset=utf-8', '', {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        });
      }
    }

    if (p === '/comment' && req.method === 'POST') {
      const b = await readBody(req);
      const pv = previews.get(b.previewId);
      if (!pv) return json(res, 404, { error: 'unknown preview' });
      /**
       * This payload lands directly in a model's context, so the surface is treated as hostile:
       * loopback-only bind, unguessable previewId, and a caller that has to be the extension's
       * own service worker. A web page cannot forge that scheme, and the overlay that asks the
       * worker to send runs in the extension's isolated world, out of the page's reach.
       *
       * Strict rather than `extensionOnly`: a request with no Origin at all - curl, any other
       * process on this machine - is not the extension either, and a comment is something the
       * user is said to have written.
       */
      if (!isExtension(req.headers.origin)) {
        return json(res, 403, { error: 'only the extension may send a comment' });
      }
      // The monitor may not have re-registered yet after a daemon restart. The session process
      // being alive is enough - the event lands in the replay buffer and is delivered on reconnect.
      if (!pidAlive(pv.sessionPid) && !sessions.has(pv.sessionKey)) {
        return json(res, 409, { error: 'the Claude session that opened this preview has ended' });
      }
      if (!listening(pv.sessionKey)) {
        return json(res, 409, {
          error: 'no Claude session is listening - run /preview in the session that should receive comments',
        });
      }
      const text = String(b.comment || '').slice(0, 8000).trim();
      if (!text) return json(res, 400, { error: 'empty comment' });
      // Last of the checks that cost nothing, and before the first thing that does: a refused
      // comment consumes no comment number, no sequence number and no disk.
      if (!allowComment(pv.sessionKey)) {
        return json(res, 429, { error: 'too many comments in a minute - wait a moment and send it again' });
      }

      // The same key the overlay files its markers under, so the two agree about what "a page"
      // is: path and query, never the hash - which is where our own #cc= token lives.
      const page = pageKey(b.page?.url || '');
      const n = store.next(b.previewId, page, b.after);
      const at = ++seq;
      let shot = null;
      // Reduced to the two fields the overlay sends, because `bridge` below is the daemon's own
      // word about its own disk and a page must not be able to put it there: /comment is called
      // from the page world, and a comment that blamed the bridge for a failure that never
      // happened would send someone to debug the one component that did its job.
      let capture = b.capture ? {
        extension: Boolean(b.capture.extension),
        error: b.capture.error ? String(b.capture.error).slice(0, 300) : undefined,
      } : undefined;
      try {
        shot = store.writeShot(pv.sessionKey, b.previewId, at, b.screenshot);
      } catch (e) {
        // The comment is the valuable thing; the picture is a nicety. A scratch directory the OS
        // cleaned out, a full disk, a mode we cannot write to - none of them is a reason to refuse
        // a comment the user has already typed. It arrives with the reason in place of the shot.
        //
        // Node puts the useful half of the message first - "ENOSPC: no space left on device,
        // write '…'" - and what follows the comma is a scratch path nobody reading the
        // notification can act on.
        const why = String(e.message).split(',')[0];
        capture = { bridge: true, error: why };
        console.error(`shot: ${why}`);
      }
      const payload = {
        seq: at, n, previewId: b.previewId, ts: new Date().toISOString(),
        repo: sessions.get(pv.sessionKey)?.repo || '', target: pv.target,
        comment: text, page: b.page || {}, anchor: b.anchor || {}, console: b.console || [], shot,
        capture: shot ? undefined : capture,
      };
      broadcast(pv.sessionKey, payload);
      saveState();
      return json(res, 200, { ok: true, n, shot: Boolean(shot) });
    }

    if (p === '/events') {
      const key = url.searchParams.get('session') || '';
      if (!SESSION_KEY.test(key)) return json(res, 400, { error: 'session required' });
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
      });
      // Sleep, a VPN flip or a dropped Wi-Fi link can leave this socket half-open: nothing
      // errors, nothing closes, and the stream is silently dead. TCP keepalive is the layer
      // that eventually notices; the client-side watchdog is what makes it quick.
      res.socket?.setKeepAlive?.(true, 15000);
      /**
       * `seq` is what a monitor with no watermark of its own adopts as one: everything up to it is
       * history it is not owed, everything after it is. That only holds if nothing numbered at or
       * below it can still be written to this stream and nothing above it can be missed - so the
       * hello, the replay and the registration below are one synchronous run. A `/comment` awaits
       * its body before it reaches `++seq`, so it cannot land in the middle of them.
       */
      res.write(`event: hello\ndata: ${JSON.stringify({
        origin: ORIGIN, pid: process.pid, instance: INSTANCE, seq,
      })}\n\n`);
      // `from` is the honest form of the question and the only one that can say "past zero";
      // `since` is what monitors from before it ask, and means nothing at 0. See store.since.
      const from = url.searchParams.get('from');
      const missed = from === null
        ? store.since(key, Number(url.searchParams.get('since')) || 0)
        : store.after(key, Number(from) || 0);
      for (const m of missed) res.write(`event: comment\ndata: ${JSON.stringify(m)}\n\n`);
      if (!clients.has(key)) clients.set(key, new Set());
      clients.get(key).add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, PING_MS);
      req.on('close', () => {
        clearInterval(ping);
        const set = clients.get(key);
        set?.delete(res);
        if (set?.size === 0) clients.delete(key);
        // When this session last had someone reading it - see `listening`.
        const s = sessions.get(key);
        if (s) s.lastStream = Date.now();
      });
      return;
    }

    return json(res, 404, { error: 'no route' });
  } catch (e) {
    return json(res, e.status || 400, { error: String(e.message || e) });
  }
});

function writeToken() {
  try { writeFileAtomic(TOKEN_FILE, TOKEN, 0o600); } catch (e) { console.error(`token: ${e.message}`); }
}

setInterval(() => {
  pruneSessions();
  // A temp-directory cleaner can take the token file out from under a long-lived daemon.
  if (readToken() !== TOKEN) writeToken();
  if (sessions.size === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) process.exit(0);
}, 30000).unref();

loadState();

server.listen(PORT, HOST, () => {
  // Only once the port is ours: a daemon that lost the race must not overwrite the winner's token.
  writeToken();
  if (process.env.LOCAL_ARTIFACT_FOREGROUND) console.log(`bridge listening on ${ORIGIN}`);
});
server.on('error', (e) => {
  // Another session already owns the daemon; that is the expected race, not a failure.
  if (e.code === 'EADDRINUSE') process.exit(0);
  console.error(String(e));
  process.exit(1);
});
