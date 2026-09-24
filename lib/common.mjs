import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = Number(process.env.LOCAL_ARTIFACT_PORT || 4517);
export const HOST = '127.0.0.1';
export const ORIGIN = `http://${HOST}:${PORT}`;
export const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/**
 * The one thing that has to outlive the temp directory: the Slack connection. A token kept in
 * STATE_DIR would be cleared by the OS along with the scratch, and logging in again every few
 * days is not a connection - it is a chore.
 */
export const CONFIG_DIR = process.env.LOCAL_ARTIFACT_CONFIG_DIR
  || path.join(os.homedir(), '.config', 'local-artifact');

/**
 * Where the user loads the Chrome extension from, once, and where it stays.
 *
 * Not the plugin's own `extension/`: an installed plugin lives under a directory named for its
 * version, so the path Chrome was pointed at would be the old version's the moment an update
 * landed - and Claude Code removes old versions. The daemon copies each newer extension in here
 * (see `syncExtension`) and the extension reloads itself from it, so the one "Load unpacked"
 * outlives every update.
 */
export const EXT_DIR = path.join(CONFIG_DIR, 'extension');

/** Everything the bridge keeps on disk: its state, its control token, per-session scratch. */
export const STATE_DIR = path.join(os.tmpdir(), 'claude-ui-comments');
// Per port, so a second daemon - a test run, say - never reads or overwrites another's.
export const STATE_FILE = path.join(STATE_DIR, `previews-${PORT}.json`);
export const TOKEN_FILE = path.join(STATE_DIR, `token-${PORT}`);

/**
 * The only shape a session key takes. Keys become directory names that are later removed
 * recursively, so anything else - `../..` above all - is refused rather than cleaned up.
 */
export const SESSION_KEY = /^p\d{1,10}$/;

/**
 * How often the daemon pings an open /events stream. Both ends of that stream need it: server.mjs
 * sends it, and monitor.mjs measures its staleness window in missed pings - a half-open socket is
 * only detectable as silence, so the reader has to know what quiet means.
 */
export const PING_MS = 25000;

/**
 * How long a monitor waits before trying the bridge again. Eagerly at first: a daemon restart
 * leaves a window in which comments are only recoverable from the replay buffer, and a shorter
 * window means fewer that depend on it. Slowly once that has plainly not worked, and at once
 * after a `bye` saying the bridge was stopped on purpose: that one is back only when somebody runs
 * /connect, and twelve quick knocks on a closed port first would be noise with nothing to find.
 *
 * Here rather than in scripts/monitor.mjs so a test can ask it without starting a monitor, which
 * goes looking for its claude process the moment it is imported.
 */
export const RETRY_FAST_MS = 400;
export const RETRY_SLOW_MS = 5000;
export const FAST_ATTEMPTS = 12;
export function retryDelay(misses, bye = null) {
  return bye?.reason === 'shutdown' || misses > FAST_ATTEMPTS ? RETRY_SLOW_MS : RETRY_FAST_MS;
}

/** Every process's pid, parent and command line, from a single `ps`. */
function processTable() {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    const table = new Map();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
    }
    return table;
  } catch {
    return new Map();
  }
}

/** `claude` itself, or `node …/claude` when Claude Code was installed through npm. */
const isClaude = (args) => args.split(/\s+/).slice(0, 2).some((a) => path.basename(a) === 'claude');

/**
 * Walk up the process tree to the `claude` process that owns this session.
 *
 * This, not CLAUDE_CODE_SESSION_ID, is the session key. The env var is present in
 * Bash tool calls but is not guaranteed to reach a plugin monitor, and the two sides
 * must agree or comments route nowhere. The ancestor PID is derivable from any
 * descendant, so monitor.mjs and connect.mjs always compute the same value.
 */
export function findClaudePid(start = process.pid) {
  const table = processTable();
  let pid = start;
  for (let i = 0; i < 32 && pid > 1; i++) {
    const proc = table.get(pid);
    if (!proc) break;
    if (isClaude(proc.args)) return pid;
    if (proc.ppid === pid) break;
    pid = proc.ppid;
  }
  return null;
}

/** `key` is null when no claude process is above this one - nothing could be routed to it. */
export function resolveSession() {
  const pid = findClaudePid();
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return { key: pid ? `p${pid}` : null, pid, cwd, repo: path.basename(cwd) };
}

/** Per-session scratch. Intermediates only - the OS reclaims it, the monitor rm -rf's it on exit. */
export function scratchDir(key) {
  if (!SESSION_KEY.test(String(key))) throw new Error(`invalid session key: ${key}`);
  return path.join(STATE_DIR, key);
}

export function ensureScratch(key) {
  const dir = scratchDir(key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where a monitor keeps the sequence number it has printed up to.
 *
 * Beside the daemon's state and not inside the session's scratch, which the monitor removes on
 * its own way out - the one event the watermark exists to survive. Per port like the state file,
 * so a test daemon neither reads nor deletes the watermark of the monitor actually in use. Both
 * ends know the path: the monitor writes it, and the daemon removes it when the session is
 * pruned, which is what stops a reused pid inheriting one.
 */
export function watermarkFile(key) {
  if (!SESSION_KEY.test(String(key))) throw new Error(`invalid session key: ${key}`);
  return path.join(STATE_DIR, `watermark-${PORT}-${key}.json`);
}

/** Write through a temp file and a rename, so a crash mid-write never leaves half a file. */
export function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** The control token the running daemon wrote, or '' when there is none. */
export function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * A call to the bridge from this machine's side of it - connect, ctl, the monitor. It carries
 * the control token, which is what tells these callers apart from a web page: a page can reach
 * the port, but it cannot read a 0600 file. Resolves to the JSON body; throws on a non-2xx,
 * with the status attached.
 */
export async function bridge(route, { body, timeout = 5000 } = {}) {
  const res = await fetch(`${ORIGIN}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-cc-token': readToken(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `${route} ${res.status}`), { status: res.status });
  return json;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The one place that decides which browser a URL opens in: Chrome by name, whatever the default
 * browser is, because that is where the extension lives - and with it captureVisibleTab and the
 * Slack session the person is already signed in to. Falling back to the default browser is for
 * the machine that has no Chrome, where an unbound tab still beats nothing opening at all.
 *
 * macOS only: `open` is a macOS command. So is everything else this plugin does today.
 */
export function openInBrowser(url) {
  // The one way out: a test that drives an open end to end must not throw a window at whoever
  // is running it. Nothing in the product sets this.
  if (process.env.LOCAL_ARTIFACT_NO_BROWSER) return;
  execFile('open', ['-a', 'Google Chrome', url], (err) => {
    if (err) execFile('open', [url], () => {});
  });
}

/** The daemon's own account of itself, or null when nothing is listening. */
export const health = () => bridge('/health', { timeout: 1500 }).catch(() => null);

/**
 * Waits, a few seconds at most, until nothing answers on the port. After a `/shutdown` the old
 * daemon still answers for a moment, with a 503, and a `/connect` run in that moment would find
 * the port taken and start nothing - so a command that stopped the bridge says so only once it is
 * true. Any answer counts, which is why this is not `health()`: that is null for a 503 as well.
 */
export async function untilStopped() {
  const answers = () => fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  for (let i = 0; i < 40 && await answers(); i++) await sleep(100);
}

/**
 * A daemon running our code, started if there is none.
 *
 * Shared by the two commands that need one before they can do anything: `/connect`, which is
 * the usual way it starts, and `/slack login`, which has to have somewhere for Slack to send
 * the browser back to.
 */
export async function ensureDaemon() {
  const h = await health();
  if (h?.build === codeBuild() && h.root === ROOT) return { note: null };
  if (h?.ok) {
    if (!h.pid) {
      // Its token file is gone - a temp-directory cleaner - and it rewrites it within 30 seconds.
      throw new Error(`the bridge on ${ORIGIN} did not accept the control token. It restores its `
        // -sTCP:LISTEN: without it lsof also lists every monitor connected to the port.
        + `token file within 30 seconds; try again then, or stop it: kill $(lsof -ti tcp:${PORT} -sTCP:LISTEN)`);
    }
    /**
     * Started from a newer copy of the plugin: an update landed and a session that started after
     * it is already running the new daemon, while this one is still running from the old copy.
     * Replacing it would be a downgrade - of the routes, of the overlay, and of the extension
     * folder the new daemon has just synced - and the next newer session would replace it back,
     * so two sessions would take turns killing each other's bridge. The newer one stays; routes
     * and fields only ever get added, so this session's older scripts still talk to it. A daemon
     * that does not report a version is from before versions existed, and is older than anything.
     */
    if (semverCmp(h.version, pluginVersion()) > 0) {
      return {
        note: `bridge ${h.version} is running from a newer copy of the plugin - `
          + 'restart this session to update it',
      };
    }
    // Started from older code, or from another copy of the plugin: it would serve its own routes
    // and its own overlay. Replace it - tabs and sessions survive, since state is on disk.
    try { process.kill(h.pid); } catch {}
    for (let i = 0; i < 30 && pidAlive(h.pid); i++) await sleep(100);
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs')], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if ((await health())?.ok) return { note: null };
  }
  throw new Error(`bridge did not come up on ${ORIGIN}`);
}

/**
 * The version this copy of the plugin was released as. Claude Code updates an installed plugin
 * only when this changes, so it is also the one number that says which of two copies is newer.
 * A copy with none reads as 0.0.0: older than every release.
 */
export function pluginVersion(root = ROOT) {
  return readVersion(path.join(root, '.claude-plugin', 'plugin.json'));
}

/** The `version` field of a JSON file, or '0.0.0' when the file, the JSON or the field is not there. */
function readVersion(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof v === 'string' && SEMVER.test(v) ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Plain `x.y.z` and nothing else. The releases are cut by scripts/release.mjs, which writes only
 * this shape, so a pre-release or build suffix is not a version this plugin ever had - it reads
 * as 0.0.0 like any other garbage, which is the answer that never causes a downgrade.
 */
export const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** -1, 0 or 1. Missing or malformed is 0.0.0, so it loses to every real version. */
export function semverCmp(a, b) {
  const parts = (v) => (SEMVER.exec(String(v ?? '')) || [0, 0, 0, 0]).slice(1).map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The files of a directory, by content: every relative path and every byte, in sorted order.
 *
 * Not mtimes, unlike `codeBuild`. A copy made by `syncExtension` has fresh mtimes whatever it
 * holds, so a stamp-based answer would call every synced folder changed and resync it on every
 * start. Dotfiles are left out - a `.DS_Store` Finder drops in the folder is not an edit.
 */
export function extensionHash(dir) {
  const hash = createHash('sha256');
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      if (name.startsWith('.')) continue;
      const r = rel ? `${rel}/${name}` : name;
      const full = path.join(dir, r);
      if (fs.statSync(full).isDirectory()) walk(r);
      // The path and the length ahead of the bytes, so moving content between files changes it.
      else hash.update(`${r}|${fs.statSync(full).size}|`).update(fs.readFileSync(full));
    }
  };
  walk('');
  return hash.digest('hex');
}

/** The manifest version of an unpacked extension, or null when there is no readable one. */
export function manifestVersion(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Copies this plugin's extension into the folder Chrome loads it from, when it is newer.
 *
 * The daemon calls this once the port is its own, which makes it the only writer: there is one
 * daemon per machine. Two processes may still meet here - a test, a daemon replaced mid-sync -
 * and each step is written so that whatever interleaving happens, `dir` ends up as one whole copy.
 *
 * The rule, by the extension manifests' versions:
 * - nothing loadable in `dir`: copy;
 * - ours is higher: copy - an update;
 * - ours is lower: never. A session still running an old copy of the plugin must not take the
 *   extension back from under a newer one;
 * - the same: only for a development checkout (`root/.git`, or LOCAL_ARTIFACT_DEV=1), and only when
 *   the contents differ. That is how an edit to `extension/` reaches the browser without a version
 *   bump; for an installed release the same version is the same code.
 *
 * The swap is a copy to a temp sibling, then two renames - `dir` to an old sibling, the temp to
 * `dir` - because macOS refuses to rename a directory onto one that is not empty. Between the two
 * there is a moment with no `dir`, which the extension's own check treats as "not yet"; what there
 * never is, is a half-written one. A second rename that fails puts the old folder back. Siblings
 * left by a process that died mid-swap are cleaned up by the next call, and a lost folder is
 * restored from them first.
 *
 * `rename` is only there for a test to make the second rename fail.
 */
export function syncExtension(root = ROOT, dir = EXT_DIR, { rename = fs.renameSync, env = process.env } = {}) {
  const src = path.join(root, 'extension');
  const to = manifestVersion(src);
  if (!to) return { synced: false, from: null, to: null, reason: 'this plugin has no extension to copy' };
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    cleanLeftovers(dir);
  } catch (e) {
    return { synced: false, from: null, to, reason: 'the folder cannot be written', error: e.message };
  }
  const from = manifestVersion(dir);
  let reason;
  if (!from) {
    reason = 'nothing loadable was there';
  } else {
    const cmp = semverCmp(to, from);
    if (cmp < 0) return { synced: false, from, to, reason: 'the folder holds a newer version' };
    if (cmp === 0) {
      const dev = env.LOCAL_ARTIFACT_DEV === '1' || fs.existsSync(path.join(root, '.git'));
      if (!dev) return { synced: false, from, to, reason: 'up to date' };
      try {
        if (extensionHash(src) === extensionHash(dir)) return { synced: false, from, to, reason: 'up to date' };
      } catch {}
      reason = 'a development edit';
    } else {
      reason = 'an update';
    }
  }

  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = `${dir}.tmp-${tag}`;
  const old = `${dir}.old-${tag}`;
  try {
    fs.cpSync(src, tmp, { recursive: true });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { synced: false, from, to, reason: 'the copy failed', error: e.message };
  }
  let moved = false;
  try {
    rename(dir, old);
    moved = true;
  } catch (e) {
    // Gone already - never there, or another process is halfway through its own swap. Either
    // way the temp copy can go straight in; if the other process got there first, that fails
    // below and its folder stands.
    if (e.code !== 'ENOENT') {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { synced: false, from, to, reason: 'the folder could not be moved aside', error: e.message };
    }
  }
  try {
    rename(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (manifestVersion(dir)) {
      // Somebody else's copy landed in the gap. It is whole, which is all that matters, and our
      // moved-aside folder is not needed to fall back on.
      if (moved) fs.rmSync(old, { recursive: true, force: true });
    } else if (moved) {
      // Put the old folder back, so Chrome still has something to load. Should even that fail,
      // it stays beside `dir` under this pid, and the next call restores it before anything else.
      try { rename(old, dir); } catch {}
    }
    return { synced: false, from, to, reason: 'the new copy could not be put in place', error: e.message };
  }
  if (moved) fs.rmSync(old, { recursive: true, force: true });
  return { synced: true, from, to, reason };
}

/**
 * What an interrupted swap left beside `dir`: temp copies and moved-aside old folders. Only those
 * of processes that are gone - a live one may be in the middle of its swap - and our own, since
 * this process runs one swap at a time and so has none in flight. A crash between the two renames
 * leaves no `dir` at all and an old folder beside it; that one goes back first.
 */
function cleanLeftovers(dir) {
  const parent = path.dirname(dir);
  const base = `${path.basename(dir)}.`;
  const stale = fs.readdirSync(parent)
    .filter((name) => name.startsWith(base))
    .map((name) => ({ name, m: /^(tmp|old)-(\d+)-[a-z0-9]+$/.exec(name.slice(base.length)) }))
    .filter(({ m }) => m && (Number(m[2]) === process.pid || !pidAlive(Number(m[2]))));
  if (!manifestVersion(dir)) {
    const back = stale.find(({ m, name }) => m[1] === 'old' && manifestVersion(path.join(parent, name)));
    if (back) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(path.join(parent, back.name), dir);
    }
  }
  for (const { name } of stale) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
}

/**
 * Changes whenever the daemon's own code does. A daemon left running from older code serves
 * old routes and an old overlay, and fails in ways that look like the new code being broken -
 * /connect compares this and replaces it.
 */
export function codeBuild(root = ROOT) {
  const hash = createHash('sha1');
  // extension/ as well, though the daemon does not run it: the daemon is what copies it into the
  // folder Chrome loads from, and only when it starts. An edit there in a development checkout
  // reaches the browser because the next /connect sees a new build, replaces the daemon, and the
  // new one syncs the folder. For an installed release the files never change under it.
  for (const [dir, re] of [['bridge', /\.mjs$/], ['lib', /\.mjs$/], ['extension', /^[^.]/]]) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch {}
    for (const name of names.filter((f) => re.test(f)).sort()) {
      hash.update(`${dir}/${name}:${fs.statSync(path.join(root, dir, name)).mtimeMs}\n`);
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/** Liveness check used to expire sessions whose claude process is gone. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * A sliding window: at most `max` allowed in any `windowMs`, refused after that.
 *
 * A refusal is deliberately not counted. Counting it would let a caller that keeps hammering a
 * closed window hold it closed indefinitely - the flood would turn into a permanent lockout
 * instead of a pause. `now` is injectable so a test does not have to sleep out a window.
 */
export function rateLimiter(max, windowMs, now = Date.now) {
  const stamps = [];
  return () => {
    const t = now();
    while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
    if (stamps.length >= max) return false;
    stamps.push(t);
    return true;
  };
}

export function shortId(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
