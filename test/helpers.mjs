import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrame } from '../lib/sse.mjs';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** A port nothing is listening on - for a daemon of our own, or for a test that wants none. */
export const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/**
 * A daemon of its own: a free port, a private TMPDIR and a private config directory, so a test
 * never touches the state, token or scratch of a bridge that is actually in use - nor the real
 * config directory, where a real Slack user token lives.
 */
export async function startBridge({ tmp, port: fixedPort, env = {} } = {}) {
  const port = fixedPort || await freePort();
  const dir = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-test-'));
  const stateDir = path.join(dir, 'claude-ui-comments');
  // Derived from `dir` rather than freshly made, so a restart onto the same tmp keeps its config.
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  // A previous daemon's token would otherwise be read before this one writes its own.
  fs.rmSync(path.join(stateDir, `token-${port}`), { force: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs')], {
    // The config directory is the empty one above unless a test names its own - never the real
    // one, which holds a real Slack token. `env` comes last so a test can still override it.
    env: {
      ...process.env,
      LOCAL_ARTIFACT_PORT: String(port),
      TMPDIR: dir,
      LOCAL_ARTIFACT_CONFIG_DIR: configDir,
      // Born already past its startup grace window. `listening()` in bridge/server.mjs lets a
      // daemon take comments for its first LOCAL_ARTIFACT_LISTEN_GRACE_MS with nobody attached,
      // on the grounds that the monitors are still reconnecting - which quietly made every test
      // daemon's youth the reason a /comment returned 200. A test that wants a comment delivered
      // attaches a real monitor with `listen`; a test about the window itself names its own value
      // in `env`, which comes last.
      LOCAL_ARTIFACT_LISTEN_GRACE_MS: '0',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const origin = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(stateDir, `token-${port}`);

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (fs.existsSync(tokenFile)) break;
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();

  /** A request with the control token unless `token: null`; `json` sets the body and its type. */
  const request = (route, { method, json, body, headers = {}, token: tok = token } = {}) =>
    fetch(`${origin}${route}`, {
      method: method || (json || body ? 'POST' : 'GET'),
      redirect: 'manual',
      headers: {
        ...(tok ? { 'x-cc-token': tok } : {}),
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });

  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });

  return { port, origin, dir, stateDir, configDir, token, request, stop, child };
}

/**
 * Registers a session owned by this test process, which is alive for as long as the test is -
 * or by `pid`, for a test that needs a session it can end.
 */
export async function register(bridge, key = `p${process.pid}`, pid = process.pid) {
  const res = await bridge.request('/register', { json: { key, pid, cwd: '/tmp/repo', repo: 'repo' } });
  if (!res.ok) throw new Error(`register ${res.status}`);
  return key;
}

/** The setup gesture with no target: `key` owns the browser from now on. */
export async function claim(bridge, key) {
  const res = await bridge.request('/claim', { json: { key } });
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * What the extension's service worker asks on every page load: whose session is this origin?
 * The raw Response, since a miss - nothing set up, an id that is not live - is a 404 a test wants.
 */
export function resolveOrigin(bridge, origin) {
  return bridge.request(`/resolve?origin=${encodeURIComponent(origin)}`, {
    token: null, headers: { origin: 'chrome-extension://abc' },
  });
}

/** Opens `target` for `key` and hands back the answer - `{ previewId, url, kind, ... }`. */
export async function preview(bridge, key, target) {
  const res = await bridge.request('/preview', { json: { key, target } });
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * A comment the way the extension sends one: no control token, and a body a real overlay could
 * have produced. Everything in `fields` goes into that body - `after`, `page`, `screenshot`,
 * `capture` - except `headers`, which is lifted out for the `origin` these tests keep varying.
 *
 * The extension's Origin by default, because that is the only caller /comment takes: a test about
 * that rule names its own `headers` (a page's origin, or none at all).
 *
 * The raw Response, not the parsed body: what most of these tests assert on is the status, and
 * several of them want a failure.
 */
export function comment(bridge, previewId, { headers, ...fields } = {}) {
  return bridge.request('/comment', {
    token: null,
    headers: headers || { origin: 'chrome-extension://abc' },
    json: {
      previewId,
      comment: 'make it blue',
      page: { url: 'http://localhost:5173/a?x=1' },
      ...fields,
    },
  });
}

/**
 * A monitor on this session's stream. Attaching one is what makes a comment deliverable at all -
 * see `listening()` in bridge/server.mjs - so a test that expects /comment to be taken needs one.
 *
 * `from` and `since` play a monitor that is reconnecting rather than starting: `from` is what a
 * current monitor asks with once it holds a watermark, `since` what one from before that asks
 * with. Neither is sent unless a test names it, which is what a monitor starting fresh does.
 * `hello` is the daemon's own greeting, whose `seq` is the watermark a new monitor adopts.
 *
 * `next()` reads the way scripts/monitor.mjs reads: frames buffered across reads, split on the
 * blank line, parsed by `parseFrame`. Never by a regex - `.` stops at the U+2028 that
 * JSON.stringify emits raw, which is the whole reason lib/sse.mjs exists.
 */
export async function listen(bridge, key, { from, since } = {}) {
  const at = [from === undefined ? '' : `&from=${from}`, since === undefined ? '' : `&since=${since}`].join('');
  const events = await fetch(`${bridge.origin}/events?session=${key}${at}`, {
    headers: { 'x-cc-token': bridge.token },
  });
  const reader = events.body.getReader();
  const dec = new TextDecoder();
  // Into the same buffer `next` reads from, so nothing that shared the hello frame's chunk is lost.
  let buf = dec.decode((await reader.read()).value, { stream: true });
  const end = buf.indexOf('\n\n');
  assert.notEqual(end, -1, buf);
  const greeting = parseFrame(buf.slice(0, end));
  assert.equal(greeting.event, 'hello', buf);
  // Consumed here so a replay sharing this chunk is all `next` ever sees.
  buf = buf.slice(end + 2);

  return {
    hello: JSON.parse(greeting.data),
    /** The next delivered comment event, as the session's monitor would receive it. */
    next: async () => {
      for (;;) {
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const { event, data } = parseFrame(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (event === 'comment' && data !== undefined) return JSON.parse(data);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('the stream ended');
        buf += dec.decode(value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}
