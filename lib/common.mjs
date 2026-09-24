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
  if (h?.build === codeBuild() && h.root === ROOT) return;
  if (h?.ok) {
    if (!h.pid) {
      // Its token file is gone - a temp-directory cleaner - and it rewrites it within 30 seconds.
      throw new Error(`the bridge on ${ORIGIN} did not accept the control token. It restores its `
        // -sTCP:LISTEN: without it lsof also lists every monitor connected to the port.
        + `token file within 30 seconds; try again then, or stop it: kill $(lsof -ti tcp:${PORT} -sTCP:LISTEN)`);
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
    if ((await health())?.ok) return;
  }
  throw new Error(`bridge did not come up on ${ORIGIN}`);
}

/**
 * Changes whenever the daemon's own code does. A daemon left running from older code serves
 * old routes and an old overlay, and fails in ways that look like the new code being broken -
 * /connect compares this and replaces it.
 */
export function codeBuild(root = ROOT) {
  const hash = createHash('sha1');
  for (const dir of ['bridge', 'lib']) {
    for (const name of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.mjs')).sort()) {
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
