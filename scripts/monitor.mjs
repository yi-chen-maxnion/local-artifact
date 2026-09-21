#!/usr/bin/env node
/**
 * Armed by the plugin host the first time /connect runs in a session (monitors/monitors.json).
 * Every line it writes to stdout is delivered to the session as a <task_notification>.
 *
 * It deliberately does NOT start the bridge daemon - /connect does that. Until one is up it
 * costs one small process and a retry timer, nothing more.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  ORIGIN, PING_MS, bridge, readToken, resolveSession, scratchDir, sleep, watermarkFile, writeFileAtomic,
} from '../lib/common.mjs';
import { fmt } from '../lib/format.mjs';
import { parseFrame } from '../lib/sse.mjs';

const session = resolveSession();
if (!session.key) {
  console.error('ui-comments: no claude process above this monitor - comments cannot be routed to it');
  process.exit(1);
}

// Reconnect eagerly at first: a daemon restart leaves a window in which comments are only
// recoverable from the replay buffer, and a shorter window means fewer that depend on it.
const RETRY_FAST_MS = 400;
const RETRY_SLOW_MS = 5000;
const FAST_ATTEMPTS = 12;
/**
 * A dead SSE stream does not announce itself. Sleep the machine, drop the Wi-Fi or flip a
 * VPN and the socket is left half-open: no error, no close, and `reader.read()` waits for a
 * byte that is never coming - so comments are accepted by the bridge and silently never
 * delivered. Two things end that wait.
 *
 * The stream is never legitimately quiet for long: the server sends a ping every PING_MS, so
 * nothing for STALE_MS means the connection is gone, whatever it claims.
 */
const TICK_MS = 5000;
const STALE_MS = 2 * PING_MS + 20000; // two missed pings plus slack
/**
 * And a tick that should take 5s taking far longer means the process was suspended - the
 * machine slept. The socket almost certainly did not survive it, so reconnect at once
 * instead of waiting out the staleness window with a stream that is already dead.
 */
const WAKE_JUMP_MS = 20000;

const WATERMARK = watermarkFile(session.key);
/**
 * When the session's claude process started, as `ps` prints it.
 *
 * The watermark has to outlive this process - the host stops and re-arms the monitor within one
 * session - so it cannot live in the scratch directory this process deletes on its way out, and
 * nothing the monitor does can be trusted to clean it up. The daemon removes it when the session
 * is pruned; until then the only thing that tells this session apart from the next process handed
 * the same pid is when that process began.
 */
const born = (() => {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(session.pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
})();

/** What a previous monitor of this same session left behind, or null. Read once, used once. */
let saved = (() => {
  try {
    const w = JSON.parse(fs.readFileSync(WATERMARK, 'utf8'));
    // A sequence number means nothing outside the daemon that issued it, and a watermark means
    // nothing outside the session incarnation that reached it.
    return Number.isFinite(w.seq) && w.instance && born && w.born === born ? w : null;
  } catch {
    return null;
  }
})();

/**
 * How far this session has been read, and by which daemon.
 *
 * `null` means no watermark at all - true only until the first hello, and only for a monitor with
 * nothing on disk. It is deliberately not 0, because 0 is a real watermark: a daemon that has
 * handed out no sequence numbers owes this session every number it will hand out. Conflating the
 * two is what lost the first comment of every session - a monitor attached for hours that had
 * never printed anything asked for a replay "from 0", which the old parameter reads as "I am new,
 * send me nothing".
 */
let lastSeq = saved ? saved.seq : null;
let instance = null;
/**
 * Which parameter says "everything after my watermark". Above zero the two are the same question,
 * so a watermark restored from disk is asked for the way a daemon of any age understands it; only
 * 0 needs `from`, and only a daemon new enough to answer it has `seq` in its hello.
 */
let fromSupported = lastSeq === 0;

function remember() {
  try { writeFileAtomic(WATERMARK, JSON.stringify({ instance, seq: lastSeq, born })); } catch {}
}

/**
 * Nothing is rate-limited here. A flood is refused by the daemon instead, per session and at the
 * same policy this file used to hold - and it answers the request with a 429 the panel prints
 * under the comment, which is the only place the answer reaches the person who pressed Send.
 * A second copy here could only ever drop a comment the page had already been told had arrived.
 *
 * The one burst this end can still see that the daemon did not throttle is a reconnect replaying
 * the buffer - up to REPLAY_MAX events at once. Every one of those was admitted under the limit
 * when it was sent, and dropping them here is exactly the silent loss being fixed.
 */
function emit(p) {
  if (lastSeq !== null && p.seq <= lastSeq) return;
  lastSeq = p.seq;
  process.stdout.write(fmt(p)); // one write => one batched notification
  // After the write, never before it: a crash between the two costs a duplicate notification,
  // and a duplicate is something the reader can see. The other order costs the comment itself.
  remember();
}

async function connect() {
  const ac = new AbortController();
  // Neither parameter until there is a watermark - the daemon's own `seq` is about to supply one,
  // and asking for a replay before then would mean asking for history this session never lost.
  const at = lastSeq === null ? '' : `&${fromSupported ? 'from' : 'since'}=${lastSeq}`;
  const res = await fetch(`${ORIGIN}/events?session=${encodeURIComponent(session.key)}${at}`, {
    // Read on every attempt: a restarted daemon has a new token.
    headers: { accept: 'text/event-stream', 'x-cc-token': readToken() },
    signal: ac.signal,
  });
  if (!res.ok || !res.body) throw Object.assign(new Error(`events ${res.status}`), { status: res.status });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastByte = Date.now();
  let lastTick = Date.now();
  // Aborting makes the pending read() reject, which drops through to the reconnect loop -
  // the same path a real network error takes, so there is only one recovery route to trust.
  const watch = setInterval(() => {
    const now = Date.now();
    const slept = now - lastTick > WAKE_JUMP_MS;
    lastTick = now;
    if (slept || now - lastByte > STALE_MS) ac.abort();
  }, TICK_MS);
  watch.unref?.();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      lastByte = Date.now();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const { event, data } = parseFrame(frame);
        if (data === undefined) continue; // a ping, or anything else without a payload
        if (event === 'hello') {
          try {
            const hello = JSON.parse(data);
            // A restarted daemon starts its numbering over - and it kept nothing to replay, so
            // there is no watermark of ours left worth holding. Without dropping it, every event
            // the new daemon sends would look like one already seen and go without a trace.
            if (hello.instance && hello.instance !== instance) {
              instance = hello.instance;
              lastSeq = null;
            }
            // A daemon from before `from=`: no watermark to adopt, so fall back to asking the only
            // way it understands, which is what this file did before any of this existed.
            fromSupported = hello.seq !== undefined;
            if (lastSeq === null) {
              // Adopt, in order of authority: what a previous monitor of this session printed up
              // to, then the daemon's own position - everything numbered before this hello is
              // history this session was never owed, everything after it will be delivered.
              lastSeq = saved?.instance === instance ? saved.seq : (fromSupported ? hello.seq : 0);
              remember();
            }
            saved = null; // it answers the first hello and nothing later
          } catch {}
          continue;
        }
        if (event === 'comment') {
          // Never silently: the bridge already answered 200 and the page already drew its pin,
          // so a comment lost here is one the user was told had arrived. The frame itself is
          // page data and stays out of the log.
          try { emit(JSON.parse(data)); } catch (e) {
            console.error(`ui-comments: dropped an unreadable comment frame: ${e.message}`);
          }
        }
      }
    }
  } finally {
    clearInterval(watch);
  }
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    try { fs.rmSync(scratchDir(session.key), { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
}

let misses = 0;
let lastRefusal = '';
for (;;) {
  try {
    await bridge('/register', { body: { key: session.key, pid: session.pid, cwd: session.cwd, repo: session.repo } });
    misses = 0;
    lastRefusal = '';
    await connect();
    misses = 0; // the stream ended cleanly; the daemon is probably restarting right now
  } catch (e) {
    misses++;
    // A daemon that is not up yet is the normal case and stays quiet - never spawn it here. One
    // that answers and refuses is not, and says why, once.
    if (e.status && e.message !== lastRefusal) console.error(`ui-comments: the bridge refused: ${e.message}`);
    if (e.status) lastRefusal = e.message;
  }
  await sleep(misses > FAST_ATTEMPTS ? RETRY_SLOW_MS : RETRY_FAST_MS);
}
