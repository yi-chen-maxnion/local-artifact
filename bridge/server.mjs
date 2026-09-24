import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXT_DIR, HOST, PORT, ORIGIN, PING_MS, ROOT, SEMVER, SESSION_KEY, STATE_DIR, STATE_FILE, TOKEN_FILE,
  codeBuild, manifestVersion, pidAlive, pluginVersion, rateLimiter, readToken, shortId, syncExtension,
  writeFileAtomic,
} from '../lib/common.mjs';
import { captureSource, fileHash, relocator } from '../lib/reanchor.mjs';
import { Store, decodeShot } from './store.mjs';
import { contentType, decodeSegments, isFile, kindOf, readIfFile, safeJoin } from './serve.mjs';
import { gonePage, slackPage, wrapperPage } from './wrapper.mjs';
import * as slack from './slack.mjs';

const MAX_BODY = 12 * 1024 * 1024; // a downscaled JPEG is ~150KB; this is slack, not a target
const IDLE_EXIT_MS = 5 * 60 * 1000;
/**
 * How long a shutdown may take before the process leaves anyway. The orderly path is over in a
 * few milliseconds; this is for a socket that never finishes flushing its goodbye.
 */
const SHUTDOWN_HARD_MS = 3000;

/**
 * Identifies this daemon process. A monitor outlives daemon restarts, so it cannot rely on
 * the seq counter alone: if a restarted daemon hands out numbers a reconnecting monitor has
 * already seen, every one of those events is silently discarded as a duplicate. The monitor
 * resets its watermark whenever this value changes.
 */
const INSTANCE = shortId(6);

/**
 * What separates this machine's own callers - connect, ctl, the monitor - from a web page.
 * A page in the browser can reach this port, and a plain `text/plain` POST from one is sent
 * without any CORS preflight; what it cannot do is read a 0600 file. So the routes that register
 * sessions, connect one to the browser, open files and stream comments require this token, which
 * is written to TOKEN_FILE once the port is ours.
 */
const TOKEN = shortId(16);
const CONTROL = new Set(['/register', '/open', '/connect', '/disconnect', '/shutdown', '/events']);
const BUILD = codeBuild(ROOT);
/**
 * The release this daemon was started from. /connect in a session still running an older copy of
 * the plugin reads it and leaves this daemon alone rather than replace it with older code - see
 * `ensureDaemon`. `PROTOCOL` is for a caller that needs to know what it may ask: it moves only if
 * a route or a field is ever taken away, which so far none has been.
 */
const VERSION = pluginVersion(ROOT);
const PROTOCOL = 1;

/**
 * The only Host headers this daemon answers to. Anything else is a name that resolves to
 * loopback without being loopback - DNS rebinding - which would make an attacker's page
 * same-origin with every route here.
 */
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const sessions = new Map(); // key -> { key, pid, cwd, repo, at }
/**
 * previewId -> an origin `{ origin, target, at }` or a served file `{ target, entry, kind, root, at }`.
 *
 * A record is a name, not a routing decision: it exists to give one origin - or one served file -
 * a stable id, because that id is the namespace its pins and its comment numbers live in. Which
 * session a comment goes to is decided at comment time from `primaryKey` and nowhere else, so
 * nothing here carries a session, and a record outlives every session that ever used it.
 */
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
 * The binding used to live in the address bar: setup minted a token, put it in the URL,
 * and a tab without it was simply not part of the loop - which meant a second tab on the same
 * app, or a link that opened one, was dead. The session owns the browser instead: `/connect` is
 * setup, and every page the extension can reach asks who it belongs to.
 *
 * Most recent setup wins. With one session - the normal case - there is nothing to decide; with
 * several, the tie-break has to be something the user did rather than something arbitrary, and
 * the overlay names the repo it is sending to so the answer is visible rather than guessed.
 */
let primaryKey = null;
/**
 * Sessions that ran `/disconnect`, key -> pid, and are never handed the browser until they run
 * `/connect` again.
 *
 * This is the daemon's state rather than the monitor's because the monitor cannot stop: the host
 * starts it the first time `/connect` runs, and restarting one that exited is nothing it promises,
 * so a monitor that went away on disconnect would leave a later `/connect` in the same session
 * connected to nothing. It stays attached instead, and nothing is routed to it because it is not
 * primary. The trap that leaves is `/register`, which the monitor sends on every reconnect and
 * which hands the browser to whoever registers when nobody holds it - so the opt-out is written
 * here, and to the state file, where a reconnect after a restart still finds it.
 *
 * The pid is kept beside the key so an entry goes with its session: a key is a pid, and a pid
 * comes round again.
 */
const detached = new Map();
/** Set once a shutdown has begun: from then on every request is refused. See `shutdown`. */
let stopping = false;

/**
 * The extension folder Chrome loads from (see EXT_DIR), as this daemon last left it: what the
 * start-up sync did, and the version now there. `latest` is read once and again after anything
 * could have changed it, not per request - it rides on every response.
 */
const extDir = { path: EXT_DIR, version: null, sync: null };
function readExtDir() {
  extDir.version = manifestVersion(EXT_DIR);
}

/**
 * On every response: the version of the extension in the folder Chrome loads from.
 *
 * This is how an extension learns there is a newer one of itself on disk. Its service worker sees
 * the header on whatever it was asking anyway, compares it with the version it is running, and
 * reloads itself when the folder is ahead - so an update needs no polling, no alarm permission
 * and nobody at chrome://extensions. Left off when the folder holds nothing readable: a missing
 * header is "nothing to move to", where a made-up version would be a reload into nothing.
 */
const extHeaders = () => (extDir.version ? { 'x-cc-ext-latest': extDir.version } : {});

function send(res, code, type, body, headers = {}) {
  res.writeHead(code, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extHeaders(),
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
 * A Chrome extension id: thirty-two letters from the first half of the alphabet. Anything else
 * carrying this header is not one, and is ignored rather than recorded.
 */
const EXTENSION_ID = /^[a-p]{32}$/;
/** When an extension last reached this daemon, and which one - see `noteExtension`. */
let extensionSeenAt = 0;
let extensionId = '';
/** The version the last one said it runs, '' for one too old to say. See `noteExtension`. */
let extensionVersion = '';
let extensionSavedAt = 0;
/**
 * Every extension id seen lately, id -> `{ version, seenAt }`.
 *
 * Normally one. Two means two copies of the extension are loaded in Chrome - the one from a zip
 * install someone never removed, beside the one from the folder that updates itself - and every
 * page then gets two buttons and two overlays fighting over it. Only /connect can say so, and only
 * if the daemon remembers more than the last id.
 */
const extensions = new Map();
/** How long a sighting counts towards "loaded now". The same window format.mjs calls fresh. */
const EXTENSION_RECENT_MS = 10 * 60 * 1000;
const recentExtensions = (now = Date.now()) => [...extensions.entries()]
  .filter(([, e]) => now - e.seenAt < EXTENSION_RECENT_MS)
  .map(([id, e]) => ({ id, version: e.version || null, seenAt: e.seenAt }));
/** How stale the saved sighting may be before another request writes it out. See `noteExtension`. */
const EXTENSION_SAVE_MS = 60 * 1000;

/**
 * The extension saying it is there, on every request it makes.
 *
 * Without the extension nothing puts the comment button on a page, so a session can be connected,
 * a file can be opened, and nothing whatever will come back - with nothing on screen to say why.
 * This is the one signal that tells a command the difference, and every place that reports status
 * prints it.
 *
 * The header alone grants nothing, and must never be made to: a page CAN send a custom header,
 * by accepting a CORS preflight, so anything at all can claim to be an extension here. What is
 * not forgeable is the Origin, which the browser sets - so this only records a sighting, only
 * when the request also comes from a chrome-extension:// origin, and no route consults it to
 * decide whether a caller is allowed anything.
 */
function noteExtension(req) {
  const id = req.headers['x-cc-ext'];
  if (typeof id !== 'string' || !EXTENSION_ID.test(id) || !isExtension(req.headers.origin)) return;
  extensionSeenAt = Date.now();
  // What it says it runs. An extension from before self-update sends nothing, and that absence
  // is itself the news: it is a copy that will never update, and /connect says to remove it.
  const said = req.headers['x-cc-ext-version'];
  const version = typeof said === 'string' && SEMVER.test(said) ? said : '';
  const fresh = id !== extensionId || version !== extensionVersion || !extensions.has(id);
  extensionId = id;
  extensionVersion = version;
  extensions.set(id, { version, seenAt: extensionSeenAt });
  // Lazily persisted. /resolve runs on every page load, and a state write per page load would be
  // the most frequent disk write this daemon makes - for a value nothing reads more than once a
  // command. Written when the id changes (a reinstall mints a new one), and otherwise at most
  // once a minute, which is far finer than the ten-minute window the line is worded against.
  if (fresh || extensionSeenAt - extensionSavedAt > EXTENSION_SAVE_MS) {
    extensionSavedAt = extensionSeenAt;
    saveState();
  }
}

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
  // server never grants anywhere. Accepting `text/plain` would let any page post here blind.
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
      seq, primaryKey, extensionSeenAt, extensionId, extensionVersion,
      extensions: recentExtensions(),
      previews: [...previews.entries()], counters: store.counters(),
      detached: [...detached.entries()],
    }));
  } catch {}
}

/**
 * How many records a restart carries forward, most recently used first.
 *
 * Nothing drops them any more - they outlive the sessions that used them, which is the whole
 * point of them - so the file is what has to be bounded. A pin is worth keeping for as long as
 * anyone might still be looking at the page it is on; two hundred origins and files is far more
 * than that and still a small file.
 */
const MAX_PREVIEWS = 200;

function loadState() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  seq = Number(raw.seq) || 0;
  primaryKey = raw.primaryKey || null;
  // The sighting outlives the daemon: an extension the user installed yesterday has not stopped
  // existing because this process was restarted, and a restart must not report it as NOT SEEN.
  extensionSeenAt = Number(raw.extensionSeenAt) || 0;
  extensionId = EXTENSION_ID.test(String(raw.extensionId || '')) ? raw.extensionId : '';
  extensionVersion = SEMVER.test(String(raw.extensionVersion || '')) ? raw.extensionVersion : '';
  for (const e of Array.isArray(raw.extensions) ? raw.extensions : []) {
    if (!EXTENSION_ID.test(String(e?.id || '')) || !Number(e.seenAt)) continue;
    extensions.set(e.id, { version: SEMVER.test(String(e.version || '')) ? e.version : '', seenAt: Number(e.seenAt) });
  }
  // Only the sessions still alive: an ended one has nothing left to opt out of, and its pid may
  // already belong to someone else.
  for (const [key, pid] of Array.isArray(raw.detached) ? raw.detached : []) {
    if (SESSION_KEY.test(String(key)) && pidAlive(Number(pid))) detached.set(key, Number(pid));
  }
  // Never written that way, since a disconnect hands the browser on first - but a file that says
  // so would otherwise route comments to a session that asked for none.
  if (detached.has(primaryKey)) primaryKey = null;
  const kept = [];
  // Rebuilt field by field rather than taken as it was written: a state file from before records
  // lost their session carries `sessionKey`, `sessionPid`, `claimed` and `claimedAt`, and reading
  // it must neither fail nor let any of that back into a live record.
  for (const [id, pv] of raw.previews || []) {
    const at = Number(pv.at) || 0;
    if (pv.entry) {
      // A served file. Drop what can no longer work: the file was deleted or moved.
      if (!isFile(pv.entry)) continue;
      kept.push([id, { target: pv.target, entry: pv.entry, kind: pv.kind, root: pv.root, at }]);
      continue;
    }
    // An origin. Ids from the older, per-target format carry only their target; given their
    // origin once, here, nothing downstream has to know the old shape existed.
    const origin = pv.origin || originOf(pv.target);
    if (!origin) continue;
    kept.push([id, { origin, target: pv.target || origin, at }]);
  }
  kept.sort((a, b) => b[1].at - a[1].at);
  // One record per origin and one per file - which a state file written before records lost their
  // session does not hold: back then an origin got a record per session that saw it, so an upgrade
  // would carry the same origin several times over, list it twice in ctl.mjs status, and leave the pins
  // under every id but the first orphaned, since `previewFor` only ever returns that first match.
  // Most recently used wins, because its pins are the ones likeliest to still be on screen.
  const seen = new Set();
  const unique = kept.filter(([, pv]) => {
    const name = pv.entry ? `f:${pv.entry}` : `o:${pv.origin}`;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  for (const [id, pv] of unique.slice(0, MAX_PREVIEWS)) previews.set(id, pv);
  store.restoreCounters(raw.counters, (id) => previews.has(id));
}

/** How a page is identified for numbering: path and query, matching the overlay's own key. */
function pageKey(u) {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch { return ''; }
}

/**
 * The file bytes a pin was captured against. Tree matching needs the version a pin's source was
 * taken from when the element itself was rewritten; quote matching does not, that evidence rides
 * on the pin.
 *
 * One file per version, named by its hash. A pin that moved carries a source for the version it
 * moved onto, so the next edit is matched from there - one snapshot per preview, the latest
 * comment's, left every pin that had already moved once with nothing to match from, and a second
 * comment overwrote the first one's. The name is only a lookup: the content is hashed again on
 * read, and a file that does not hash to what the pin says is not that version.
 *
 * Keyed by the preview id, which is the hex `shortId` mints, and the hex hash, so neither can
 * be a path.
 */
const SNAPS_KEPT = 8;

function snapPrefix(previewId) {
  if (!/^[a-f0-9]{8,32}$/i.test(previewId || '')) return null;
  return `snap-${PORT}-${previewId}-`;
}

function snapPath(previewId, hash) {
  const prefix = snapPrefix(previewId);
  if (!prefix || !/^[a-f0-9]{64}$/.test(hash || '')) return null;
  return path.join(STATE_DIR, `${prefix}${hash.slice(0, 16)}`);
}

/** Marks a snapshot as used, so pruning keeps the versions pins still point at. */
function touchSnap(file) {
  const now = new Date();
  try { fs.utimesSync(file, now, now); } catch {}
}

/** Only the newest few versions of a preview. A pin older than all of them matches by quote alone. */
function pruneSnaps(previewId) {
  const prefix = snapPrefix(previewId);
  if (!prefix) return;
  try {
    const mine = fs.readdirSync(STATE_DIR)
      .filter((name) => name.startsWith(prefix) && !name.endsWith('.tmp'))
      .map((name) => {
        const file = path.join(STATE_DIR, name);
        try { return { file, t: fs.statSync(file).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    for (const { file } of mine.slice(SNAPS_KEPT)) fs.rmSync(file, { force: true });
  } catch {}
}

function writeSnap(previewId, html, hash = fileHash(html)) {
  const file = snapPath(previewId, hash);
  if (!file) return;
  if (fs.existsSync(file)) return touchSnap(file);
  try { writeFileAtomic(file, html); } catch { return; }
  pruneSnaps(previewId);
}

/** The bytes of that version, or null when they are gone or are not what the hash says. */
function readSnap(previewId, hash) {
  const file = snapPath(previewId, hash);
  if (!file) return null;
  try {
    const html = fs.readFileSync(file, 'utf8');
    if (fileHash(html) !== hash) return null;
    touchSnap(file);
    return html;
  } catch { return null; }
}

/**
 * The versions of a preview kept on disk, most recently served or used first. A file whose bytes
 * do not hash to its name is skipped rather than trusted.
 */
function snapVersions(previewId) {
  const prefix = snapPrefix(previewId);
  if (!prefix) return [];
  try {
    return fs.readdirSync(STATE_DIR)
      .filter((name) => name.startsWith(prefix) && !name.endsWith('.tmp'))
      .map((name) => {
        const file = path.join(STATE_DIR, name);
        try { return { file, name, t: fs.statSync(file).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t)
      .map(({ file, name }) => {
        try {
          const html = fs.readFileSync(file, 'utf8');
          const hash = fileHash(html);
          return name === `${prefix}${hash.slice(0, 16)}` ? { file, html, hash } : null;
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * The served HTML file a page is, from its URL: `{ previewId, pv }` for the entry page of a file
 * this bridge serves at `/p/<id>/`, else null.
 *
 * Not from the preview id the extension sends. Every tab on this origin is bound to the origin's
 * record, so that id is the same for every file served here and names none of them; the URL is
 * the only thing the extension has that does. Only the entry itself counts: a page further down
 * the tree is another document, and a source taken against the entry would describe the wrong one.
 */
function servedHtml(pageUrl) {
  let u;
  try { u = new URL(pageUrl || ''); } catch { return null; }
  if (u.origin !== ORIGIN) return null;
  const m = /^\/p\/([^/]+)\/$/.exec(u.pathname);
  const pv = m ? previews.get(m[1]) : null;
  if (pv?.kind !== 'html' || !pv.entry) return null;
  return { previewId: m[1], pv };
}

/**
 * Where a comment on a served HTML file was pointing, in that file, or null.
 * Null is not a failed comment: the pin keeps its selector and nothing more.
 *
 * Captured against the file as it is now, when the element there is the one the user pointed at.
 * When it is not, the tab is showing an older version - Claude wrote the file after it loaded -
 * and the versions served since are tried, most recent first. The first one where the anchor is
 * found and agrees is the one the tab showed; the source is taken against it and carries its
 * hash, and the next /reanchor moves the pin from there onto the file as it is. None agreeing is
 * no source, as before.
 */
function sourceFor(file, anchor) {
  if (!file) return null;
  const buf = readIfFile(file.pv.entry);
  if (!buf) return null;
  const html = buf.toString('utf8');
  try {
    const source = captureSource(html, anchor || {});
    if (source) {
      writeSnap(file.previewId, html, source.hash);
      return source;
    }
    const current = fileHash(html);
    for (const version of snapVersions(file.previewId)) {
      if (version.hash === current) continue;
      const earlier = captureSource(version.html, anchor || {});
      if (!earlier) continue;
      touchSnap(version.file);
      return earlier;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The file on disk a comment is about, when the page it came from is one this bridge serves.
 *
 * A comment on `http://127.0.0.1:4517/p/a1b2c3d4/` names a loopback URL and nothing else, which
 * says nothing about which file the session should go and edit. The record already knows, so the
 * notification carries the path rather than making a session guess it back.
 */
function fileFor(pageUrl) {
  let u;
  // No base: a relative URL is not a page the browser was on, and must not resolve into one.
  try { u = new URL(pageUrl || ''); } catch { return undefined; }
  if (u.origin !== ORIGIN) return undefined;
  const [, p, id] = u.pathname.split('/');
  if (p !== 'p' || !id) return undefined;
  return previews.get(id)?.entry;
}

/** The origin of an http(s) target, or null for anything else. */
function originOf(target) {
  try {
    const u = new URL(target);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}

/**
 * One record per origin and one per served file, created on demand and then reused - so a page's
 * markers, which live in `localStorage` under the preview id, survive a second open, another
 * session taking the browser, and a daemon restart. Minting a fresh id per invocation silently
 * orphaned every pin, and minting one per session orphaned them again at every handover.
 *
 * Every hit is a use, so `at` is what the bound in `loadState` reads: the records a restart keeps
 * are the ones pages were recently resolving.
 */
function previewFor(match, init) {
  for (const [previewId, pv] of previews) {
    if (!match(pv)) continue;
    pv.at = Date.now();
    return { previewId, pv, created: false };
  }
  const previewId = shortId(8);
  const pv = { ...init, at: Date.now() };
  previews.set(previewId, pv);
  return { previewId, pv, created: true };
}

const originPreview = (origin) => previewFor((pv) => pv.origin === origin, { origin, target: origin });

/**
 * The session every comment goes to, or null when nothing is connected.
 *
 * One rule, asked at the moment a comment arrives rather than at the moment a page was first
 * seen: the session that ran `/connect` last. Where a page came from does not enter into it -
 * an origin is a name for pins, not a claim on anyone's attention.
 */
const connectedSession = () => (primaryKey && sessions.has(primaryKey) ? primaryKey : null);

/**
 * Who the browser passes to when its holder lets go of it, by ending or by `/disconnect`: the
 * remaining session that registered most recently, leaving out every one that asked not to be.
 */
const successor = () => [...sessions.values()]
  .filter((s) => !detached.has(s.key))
  .sort((a, b) => b.at - a.at)[0]?.key || null;

function pruneSessions() {
  let changed = false;
  // Before the sessions, and separately: a detached session need not be registered at all - its
  // monitor may not have come back since a restart - and its entry still has to go when it ends.
  for (const [key, pid] of detached) {
    if (pidAlive(pid)) continue;
    changed = true;
    detached.delete(key);
  }
  for (const [key, s] of sessions) {
    if (pidAlive(s.pid)) continue;
    changed = true;
    sessions.delete(key);
    // The records stay. They are ids for pins that are still on pages in the browser, and the
    // next session to connect inherits both rather than starting the numbering over.
    for (const res of clients.get(key) || []) { try { res.end(); } catch {} }
    clients.delete(key);
    commentRate.delete(key);
    store.forget(key);
  }
  if (!changed) return;
  // The browser does not go unowned because its owner ended: it passes to whichever remaining
  // session registered most recently, unless that session has disconnected.
  if (!sessions.has(primaryKey)) primaryKey = successor();
  saveState();
}

/**
 * Is anything going to read this?
 *
 * A comment is written into a replay buffer and pushed to whatever monitors are streaming. With
 * no monitor - a session where `/connect` was never run, one whose monitor never armed, one that
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
    // Whatever it is: the state has been written, and anything changed now would be lost with it.
    if (stopping) return send(res, 503, 'application/json; charset=utf-8',
      JSON.stringify({ error: 'the bridge is shutting down' }), { connection: 'close' });
    if (!HOSTS.has(req.headers.host)) return json(res, 421, { error: 'unexpected host' });
    // Before the routes, because it is about the caller rather than about the route: any request
    // the extension makes is a sighting, including the ones that are then refused.
    noteExtension(req);
    if (CONTROL.has(p) && !hasToken(req)) return json(res, 401, { error: 'control token required' });

    if (p === '/health') {
      // Anyone may learn the bridge is up; only a caller holding the token learns what is in it.
      // The version is public: a /connect whose token was refused can still tell a newer daemon.
      if (!hasToken(req)) return json(res, 200, { ok: true, instance: INSTANCE, version: VERSION });
      pruneSessions();
      return json(res, 200, {
        ok: true, pid: process.pid, origin: ORIGIN, instance: INSTANCE, root: ROOT, build: BUILD,
        version: VERSION, protocol: PROTOCOL,
        primary: primaryKey, slack: slack.status(),
        // Null for never, which is what every command turns into "install the extension".
        extension: extensionSeenAt
          ? { seenAt: extensionSeenAt, id: extensionId, version: extensionVersion || null }
          : null,
        extensionVersion: extensionVersion || null,
        extensions: recentExtensions(),
        extDir: {
          path: extDir.path, version: extDir.version,
          ...(extDir.sync?.error ? { error: extDir.sync.error } : {}),
          sync: extDir.sync,
        },
        sessions: [...sessions.values()].map((s) => ({
          ...s, clients: clients.get(s.key)?.size || 0, detached: detached.has(s.key),
        })),
        previews: [...previews.entries()].map(([id, v]) => ({
          id, target: v.target, kind: v.kind, origin: v.origin || undefined,
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
      // another session - but if nothing holds it, someone has to. Not a session that ran
      // /disconnect: its monitor stays attached and re-registers on every reconnect, and taking
      // the browser here would undo the disconnect the first time the stream dropped.
      if (!sessions.has(primaryKey) && !detached.has(b.key)) primaryKey = b.key;
      return json(res, 200, { ok: true, previews: previews.size });
    }

    /**
     * Setup with nothing to open: `/connect`, which names no target. With the extension installed
     * that is all most sessions need, since every page already carries the button and only has to
     * be told whose session it reports to.
     */
    if (p === '/connect' && req.method === 'POST') {
      const b = await readBody(req);
      if (!sessions.has(b.key)) return json(res, 409, { error: 'session not registered' });
      /**
       * Who is losing the browser. Read before the pruning below so a session that has merely
       * ended is not reported as having had it taken, and only when it is somebody else: this
       * is a handover the other session will never be told about, so the one doing the taking
       * says it out loud rather than letting comments move without a word.
       */
      const before = primaryKey;
      pruneSessions();
      const prior = before !== b.key && sessions.has(before) ? sessions.get(before) : null;
      // The whole of the setup gesture: from now on this session owns the browser, and every
      // comment from every page goes to it. It is also the only way back from /disconnect.
      detached.delete(b.key);
      primaryKey = b.key;
      saveState();
      return json(res, 200, {
        ok: true,
        primary: primaryKey,
        previous: prior ? { key: prior.key, repo: prior.repo } : null,
      });
    }

    /**
     * `/disconnect`: this session stops receiving comments, and stays that way until it runs
     * `/connect`. If it held the browser, the browser passes on as it would had the session ended.
     *
     * The session's monitor is not told and does not stop - see `detached` for why it cannot - so
     * all of this is the daemon's to remember. A session that was never registered is marked all
     * the same: its monitor may simply not have come back since a restart, and it would otherwise
     * be handed the browser the moment it did.
     */
    if (p === '/disconnect' && req.method === 'POST') {
      const b = await readBody(req);
      const key = String(b.key);
      const pid = Number(key.slice(1));
      if (!SESSION_KEY.test(key) || !pidAlive(pid)) {
        return json(res, 400, { error: 'a valid session key with a live pid is required' });
      }
      pruneSessions();
      const already = detached.has(key);
      const held = primaryKey === key;
      detached.set(key, pid);
      if (held) primaryKey = successor();
      saveState();
      const now = connectedSession();
      return json(res, 200, {
        ok: true, already, held, registered: sessions.has(key),
        primary: now ? { key: now, repo: sessions.get(now).repo } : null,
      });
    }

    /**
     * Stopping the daemon, from this machine's side: `/disconnect --stop` and `ctl.mjs stop`.
     *
     * Answered before anything closes, and with every session that was registered, because the
     * caller is about to say which other sessions just lost their comments - and a caller whose
     * request was cut off by the very shutdown it asked for could say nothing at all. Every request
     * after this one is refused.
     */
    if (p === '/shutdown' && req.method === 'POST') {
      await readBody(req);
      pruneSessions();
      const was = [...sessions.values()].map((s) => ({
        key: s.key, repo: s.repo, primary: s.key === primaryKey, detached: detached.has(s.key),
      }));
      stopping = true;
      const go = () => shutdown('shutdown');
      res.once('finish', go);
      res.once('close', go);
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, sessions: was }), {
        connection: 'close',
      });
    }

    /**
     * A local file, put in front of the user. This is Claude's gesture and nobody else's: it has
     * produced something whose point is to be looked at, and the file is served under `/p/<id>/`
     * so that the extension can put the comment button on it as it does on any other page.
     *
     * Local files only. A web page needs nothing opened - every page the user visits already
     * carries the button - and a PDF cannot be commented on at all, since nothing can place an
     * anchor inside Chrome's viewer. Both are refused here rather than half-served.
     *
     * Opening is NOT a setup gesture. Which session receives comments is `/connect`'s answer and
     * nothing else's; a file opened by a session that does not hold the browser must not quietly
     * take it, or the user's own pages would start reporting somewhere they never asked for.
     */
    if (p === '/open' && req.method === 'POST') {
      const b = await readBody(req);
      if (!sessions.has(b.key)) return json(res, 409, { error: 'session not registered' });
      const target = String(b.target || '');
      if (originOf(target)) {
        return json(res, 400, {
          error: 'web pages need no opening - every page already carries the comment button',
        });
      }
      if (/\.pdf$/i.test(target)) {
        return json(res, 415, { error: "PDF is not supported - Chrome's PDF viewer admits no anchor" });
      }
      const entry = path.resolve(target);
      if (!isFile(entry)) return json(res, 404, { error: `not a file: ${entry}` });
      // Reused, not re-minted. The id is the namespace this file's markers live in.
      const { previewId, pv } = previewFor((rec) => rec.entry === entry, {
        kind: kindOf(entry), target, entry, root: path.dirname(entry),
      });
      saveState();
      return json(res, 200, { previewId, url: `${ORIGIN}/p/${previewId}/`, kind: pv.kind });
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
      const key = connectedSession();
      if (!key) {
        return json(res, 404, {
          error: 'no session is set up',
          hint: 'run /connect in the Claude session that should receive comments',
        });
      }
      // The id is the origin's own and says nothing about who receives its comments; the repo
      // beside it is read fresh every time, so a page shows the session that holds the browser
      // now rather than the one that happened to be there when the id was minted.
      const found = originPreview(origin);
      if (found.created) saveState();
      return json(res, 200, {
        previewId: found.previewId,
        repo: sessions.get(key).repo,
        slack: slackFor(),
      });
    }

    /**
     * What the toolbar menu says above Slack: is any session connected to this browser, and which
     * repo is it. A page carrying the comment button and no session behind it looks exactly like
     * one that works, and the menu is the only place that can say so without a comment being sent.
     *
     * The extension's alone, like /resolve, and for the same reason: which repo a person has open
     * is theirs, not a web page's. Nothing here is a routing token, so it is deliberately less
     * than /resolve hands back.
     */
    if (p === '/status') {
      if (!extensionOnly(req)) return json(res, 403, { error: 'not available to a web page' });
      pruneSessions();
      const key = connectedSession();
      return json(res, 200, { connected: Boolean(key), repo: key ? sessions.get(key).repo : '' });
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
        repo: sessions.get(connectedSession())?.repo || '',
        comment: text,
        page: b.page || {},
        anchor: b.anchor || {},
        console: b.console || [],
        file: fileFor(b.page?.url),
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
      // An origin's record names no file, so there is nothing here for it to serve.
      if (!pv?.entry) return html(res, 404, gonePage(previewId));
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
          // The version this tab is about to show. Claude may write the file while the user is
          // still reading it, and a comment from this tab has to be anchored against these bytes,
          // not the ones on disk by then - see sourceFor.
          writeSnap(previewId, buf.toString('utf8'));
          return send(res, 200, contentType(pv.entry), buf);
        }
        // An image is linked from the wrapper page, not read into it.
        const linked = pv.kind === 'image';
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

    /**
     * No CORS anywhere on this server, /comment included. It used to grant a preflight here for
     * the one caller that needed one - a bookmarklet on a dev server posting cross-origin - and
     * that caller is gone: a comment comes from the extension's service worker, whose fetch is
     * covered by the manifest's host_permissions and is not subject to CORS at all. What a page
     * would get from the block that stood here is a preflight it can no longer pass, which is
     * the right answer to a route that refuses every page anyway.
     */
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
      // Where this comment goes, asked now rather than when the page was first seen: the session
      // that ran /connect last. The record only said which page it came from.
      const key = connectedSession();
      if (!key) {
        return json(res, 409, { error: 'no Claude session is connected - run /connect' });
      }
      if (!listening(key)) {
        return json(res, 409, {
          error: 'no Claude session is listening - run /connect in the session that should receive comments',
        });
      }
      const text = String(b.comment || '').slice(0, 8000).trim();
      if (!text) return json(res, 400, { error: 'empty comment' });
      // Last of the checks that cost nothing, and before the first thing that does: a refused
      // comment consumes no comment number, no sequence number and no disk.
      if (!allowComment(key)) {
        return json(res, 429, { error: 'too many comments in a minute - wait a moment and send it again' });
      }

      // The same key the overlay files its markers under, so the two agree about what "a page"
      // is: path and query, never the hash - a route inside one page, not a page of its own.
      const page = pageKey(b.page?.url || '');
      const n = store.next(b.previewId, page, b.after);
      const at = ++seq;
      let shot = null;
      // Reduced to the one field the overlay sends, because `bridge` below is the daemon's own
      // word about its own disk and nothing upstream may put it there: this route is the
      // extension's alone, but a comment that blamed the bridge for a failure that never happened
      // would still send someone to debug the one component that did its job.
      let capture = b.capture?.error
        ? { error: String(b.capture.error).slice(0, 300) }
        : undefined;
      try {
        shot = store.writeShot(key, b.previewId, at, b.screenshot);
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
        repo: sessions.get(key)?.repo || '', target: pv.target,
        comment: text, page: b.page || {}, anchor: b.anchor || {}, console: b.console || [], shot,
        capture: shot ? undefined : capture,
        file: fileFor(b.page?.url),
      };
      broadcast(key, payload);
      saveState();
      // For the overlay, not the session. The notification already describes the anchor; this is
      // how the pin finds it again after the file is edited. Missing means the pin stays as it
      // was — a comment is not refused because the file could not be anchored.
      // The file comes from the page's URL, not from `b.previewId`: that is the origin's id,
      // shared by every page on it - see servedHtml.
      const source = sourceFor(servedHtml(b.page?.url), b.anchor);
      return json(res, 200, { ok: true, n, shot: Boolean(shot), ...(source ? { source } : {}) });
    }

    /**
     * A served HTML file changed after the comment was left. The overlay asks, once it is
     * looking at the file, where each pin's source anchor went. Extension-only, like /comment:
     * the answer is where the user's pins move, and a page does not get to say.
     *
     * The file is the page the overlay is on, named by `pageUrl`; `previewId` is the origin's
     * and names no file - see servedHtml. A page that is not a file we serve answers with nothing
     * to move, and the overlay leaves those pins on their selectors. Nothing inside a pin's source
     * says which file it is: the source is the overlay's to send, and says only what it recorded.
     */
    if (p === '/reanchor' && req.method === 'POST') {
      if (!isExtension(req.headers.origin)) {
        return json(res, 403, { error: 'only the extension may reanchor' });
      }
      const b = await readBody(req);
      const file = servedHtml(b.pageUrl);
      if (!file) return json(res, 200, { pins: [] });
      const buf = readIfFile(file.pv.entry);
      if (!buf) return json(res, 404, { error: 'file is gone' });
      const html = buf.toString('utf8');
      // One parse of the file on disk and of each old version, however many pins ask, and one
      // clock for all of them: this runs on the loop every session's comments arrive on.
      const move = relocator(html);
      const hash = fileHash(html);
      const versions = new Map();
      const versionOf = (h) => {
        if (!versions.has(h)) versions.set(h, readSnap(file.previewId, h));
        return versions.get(h);
      };
      const pins = Array.isArray(b.pins) ? b.pins.slice(0, 100) : [];
      let moved = false;
      const out = pins.map((pin) => {
        const src = pin?.source;
        if (!src || typeof src !== 'object' || typeof src.hash !== 'string') return { n: pin?.n, skipped: true };
        if (src.hash === hash) return { n: pin.n, same: true };
        try {
          const result = move(versionOf(src.hash), src);
          if (result.source) moved = true;
          return { n: pin.n, ...result };
        } catch {
          return { n: pin.n, lost: true };
        }
      });
      // A pin that moved now carries a source for this version, and a pin already on it has one,
      // so this version is what the next edit has to be matched from. Kept whether or not the
      // overlay adopts the move: a pin that does not still has its old version, also kept.
      if (moved || out.some((r) => r.same)) writeSnap(file.previewId, html, hash);
      return json(res, 200, { hash, pins: out });
    }

    if (p === '/events') {
      const key = url.searchParams.get('session') || '';
      if (!SESSION_KEY.test(key)) return json(res, 400, { error: 'session required' });
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
        ...extHeaders(),
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

const housekeeping = setInterval(() => {
  pruneSessions();
  // Someone may have emptied or replaced the folder by hand; the header should say what is there.
  readExtDir();
  // A temp-directory cleaner can take the token file out from under a long-lived daemon.
  if (readToken() !== TOKEN) writeToken();
  if (sessions.size === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) shutdown('idle');
}, 30000);
housekeeping.unref();

/**
 * The one way this daemon ends once it has served anything: `/shutdown`, a signal, or idling out.
 *
 * In this order, and each step for a reason. New requests are refused first, so nothing lands
 * after the state is written. The state is written before any stream is touched, so what a
 * restart reads is what this process last knew. Every monitor is told `bye` with the reason
 * before its stream ends, because an ended stream on its own looks exactly like a daemon that
 * crashed and is coming straight back - which a monitor answers with a burst of fast retries -
 * where a stopped bridge will be back only when someone runs /connect. The listener and the
 * connections close only once those goodbyes have been flushed. The token file goes last, and
 * only while it is still this process's: a daemon started the moment the port came free has
 * written its own there.
 *
 * Idempotent, since a signal can arrive in the middle of a /shutdown. The hard exit is for the
 * one thing that can hang it - a socket that never finishes flushing - and exits 0 as well,
 * since the state was saved before anything could hang.
 */
let closing = false;
function shutdown(reason) {
  if (closing) return;
  closing = true;
  stopping = true;
  setTimeout(finish, SHUTDOWN_HARD_MS).unref();
  clearInterval(housekeeping);
  saveState();
  const bye = `event: bye\ndata: ${JSON.stringify({ reason })}\n\n`;
  const flushed = [];
  for (const set of clients.values()) {
    for (const res of set) {
      flushed.push(new Promise((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
        try { res.end(bye); } catch { resolve(); }
      }));
    }
  }
  clients.clear();
  server.close(finish);
  Promise.all(flushed).then(() => server.closeAllConnections());
}

function finish() {
  try { if (readToken() === TOKEN) fs.rmSync(TOKEN_FILE, { force: true }); } catch {}
  process.exit(0);
}

// `signal` rather than `shutdown`: a signal is also how /connect replaces a daemon running older
// code, and the monitors should be back on the new one in a moment rather than on the slow retry.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown('signal'));

loadState();

server.listen(PORT, HOST, () => {
  // Only once the port is ours: a daemon that lost the race must not overwrite the winner's token.
  writeToken();
  if (process.env.LOCAL_ARTIFACT_FOREGROUND) console.log(`bridge listening on ${ORIGIN}`);
  /**
   * The extension folder, brought up to this copy of the plugin - here, and only here, because
   * the daemon that holds the port is the one process of its kind on the machine: one writer, so
   * two sessions starting at once never copy over each other. Before this, the header says what
   * the folder held; after it, what it holds now. Synchronous and a few hundred kilobytes: the
   * requests that queue behind it wait milliseconds.
   */
  try {
    extDir.sync = syncExtension();
  } catch (e) {
    extDir.sync = { synced: false, reason: 'the sync failed', error: e.message };
  }
  readExtDir();
  if (extDir.sync.error) console.error(`extension folder: ${extDir.sync.reason}: ${extDir.sync.error}`);
  else if (process.env.LOCAL_ARTIFACT_FOREGROUND) {
    console.log(`extension folder ${EXT_DIR}: ${extDir.sync.synced ? 'synced' : 'kept'} (${extDir.sync.reason})`);
  }
});
readExtDir();
server.on('error', (e) => {
  // Another session already owns the daemon; that is the expected race, not a failure.
  if (e.code === 'EADDRINUSE') process.exit(0);
  console.error(String(e));
  process.exit(1);
});
