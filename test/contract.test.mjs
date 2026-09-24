import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXTENSION_ID, ROOT, comment, connect, listen, open, register, seenExtension, startBridge,
} from './helpers.mjs';

/**
 * What the daemon owes the callers that are NOT updated with it.
 *
 * A daemon outlives the code that talks to it. After an update, a newer daemon serves monitors
 * started from the old copy of the plugin - the host started them at session start and never
 * restarts them - and an extension that has not reloaded yet; `ensureDaemon` also deliberately
 * keeps a newer daemon for an older session's /connect. So routes and response fields are
 * add-only, and this file is where taking one away fails: every route the monitor, the scripts
 * and the extension call, with every field they read, asked of a real daemon.
 *
 * A route a caller starts using has to be added here too - the first test reads the callers'
 * source and fails on one it has never heard of.
 */
const PINNED = {
  // scripts/monitor.mjs
  monitor: ['/register', '/events'],
  // scripts/connect.mjs, disconnect.mjs, open.mjs, ctl.mjs, and ensureDaemon in lib/common.mjs
  scripts: ['/health', '/register', '/connect', '/disconnect', '/open', '/shutdown', '/slack/login', '/slack/logout'],
  // extension/background.js
  extension: [
    '/health', '/resolve', '/status', '/comment', '/reanchor',
    '/slack/status', '/slack/login', '/slack/logout', '/slack/destinations', '/slack/share',
  ],
};

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const routesIn = (text, re) => [...text.matchAll(re)].map((m) => m[1].replace(/[?`$].*$/, ''));

describe('the callers call nothing this file does not pin', () => {
  test('extension/background.js', () => {
    const used = new Set(routesIn(src('extension/background.js'), /\bcall\(\s*[`'"](\/[^`'"?$]*)/g));
    assert.ok(used.size >= 5, `found only ${[...used]} - has the way it calls the bridge changed?`);
    for (const r of used) assert.ok(PINNED.extension.includes(r), `the extension calls ${r}, which nothing here pins`);
  });

  test('the scripts and lib/common.mjs', () => {
    const used = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => n.endsWith('.mjs'))) {
      for (const r of routesIn(src(`scripts/${f}`), /\bbridge\(\s*[`'"](\/[^`'"?$]*)/g)) used.add(r);
    }
    for (const r of routesIn(src('lib/common.mjs'), /\bbridge\(\s*[`'"](\/[^`'"?$]*)/g)) used.add(r);
    assert.ok(used.size >= 5, `found only ${[...used]}`);
    const all = [...PINNED.scripts, ...PINNED.monitor];
    for (const r of used) assert.ok(all.includes(r), `a script calls ${r}, which nothing here pins`);
    assert.match(src('scripts/monitor.mjs'), /\/events\?session=/);
  });
});

/** Every key in `keys` is present on `obj` - more is fine, that is what add-only allows. */
function has(obj, keys, what) {
  assert.ok(obj && typeof obj === 'object', `${what}: not an object: ${JSON.stringify(obj)}`);
  for (const k of keys) assert.ok(k in obj, `${what} lost "${k}": ${JSON.stringify(obj)}`);
}

describe('each pinned route answers with the fields its callers read', () => {
  let bridge;
  let key;
  let files;
  const EXT = { origin: `chrome-extension://${EXTENSION_ID}`, 'x-cc-ext': EXTENSION_ID };
  const asExtension = (route, init = {}) => bridge.request(route, { token: null, ...init, headers: { ...EXT, ...init.headers } });

  // Registered and connected here rather than by the first test, so any one of these can be run
  // on its own - which is how each was seen to fail with its field taken away.
  before(async () => {
    bridge = await startBridge();
    files = fs.mkdtempSync(path.join(bridge.dir, 'files-'));
    key = await register(bridge);
    await connect(bridge, key);
    await seenExtension(bridge);
  });
  after(() => bridge.stop());

  test('/register and /connect - the monitor and /connect', async () => {
    const res = await bridge.request('/register', { json: { key, pid: process.pid, cwd: '/tmp/r', repo: 'r' } });
    assert.equal(res.status, 200);
    has(await res.json(), ['ok'], '/register');
    has(await connect(bridge, key), ['ok', 'primary', 'previous'], '/connect');
  });

  test('/health with the token - ctl status, /connect, open.mjs, ensureDaemon', async () => {
    const h = await (await bridge.request('/health')).json();
    has(h, ['ok', 'pid', 'origin', 'instance', 'root', 'build', 'version', 'protocol', 'primary',
      'slack', 'extension', 'extensionVersion', 'extensions', 'extDir', 'sessions', 'previews'], '/health');
    has(h.extension, ['seenAt', 'id', 'version'], '/health extension');
    has(h.extDir, ['path', 'version'], '/health extDir');
    has(h.slack, ['configured', 'connected', 'user', 'team', 'last'], '/health slack');
    has(h.sessions.find((s) => s.key === key), ['key', 'pid', 'repo', 'cwd', 'clients', 'detached'], '/health sessions[]');
    has(h.extensions[0], ['id', 'version', 'seenAt'], '/health extensions[]');
    assert.ok(Array.isArray(h.previews));
  });

  test('/health without it - untilStopped, the extension, a newer-daemon check', async () => {
    const res = await asExtension('/health');
    has(await res.json(), ['ok', 'instance', 'version'], 'public /health');
    assert.ok(res.headers.get('x-cc-ext-latest'), 'the header the extension updates on');
  });

  test('/events - hello, comment and the fields the monitor prints', async () => {
    const stream = await listen(bridge, key);
    has(stream.hello, ['origin', 'pid', 'instance', 'seq'], 'hello');
    const r = await asExtension('/resolve?origin=http%3A%2F%2Flocalhost%3A7400');
    const { previewId } = await r.json();
    const sent = await comment(bridge, previewId, { headers: EXT, anchor: { kind: 'element', selector: 'b' } });
    has(await sent.json(), ['ok', 'n', 'shot'], '/comment');
    const p = await stream.next();
    has(p, ['seq', 'n', 'previewId', 'ts', 'repo', 'target', 'comment', 'page', 'anchor', 'console'], 'comment event');
    await stream.close();
  });

  test('/resolve and /status - the extension on every page, and its menu', async () => {
    const r = await asExtension('/resolve?origin=http%3A%2F%2Flocalhost%3A7401');
    assert.equal(r.status, 200);
    const body = await r.json();
    has(body, ['previewId', 'repo', 'slack'], '/resolve');
    has(body.slack, ['connected'], '/resolve slack');
    has(await (await asExtension('/status')).json(), ['connected', 'repo'], '/status');
  });

  test('/open and /reanchor - a served file, and where its pins went', async () => {
    const file = path.join(files, 'page.html');
    fs.writeFileSync(file, '<main><p id="a">hello</p></main>');
    const opened = await open(bridge, key, file);
    has(opened, ['previewId', 'url', 'kind'], '/open');
    const nothing = await asExtension('/reanchor', { json: { pageUrl: 'http://localhost:7400/', pins: [] } });
    has(await nothing.json(), ['pins'], '/reanchor off a served file');
    const served = await asExtension('/reanchor', {
      json: { pageUrl: opened.url, pins: [{ n: 1, source: { hash: 'f'.repeat(64) } }] },
    });
    const j = await served.json();
    has(j, ['hash', 'pins'], '/reanchor');
    has(j.pins[0], ['n'], '/reanchor pins[]');
  });

  test('the Slack routes - the panel and the toolbar menu', async () => {
    has(await (await asExtension('/slack/status')).json(), ['configured', 'connected', 'user', 'team'], '/slack/status');
    const dest = await asExtension('/slack/destinations?q=x');
    has(await dest.json(), ['error', 'code'], '/slack/destinations, not connected');
    const share = await asExtension('/slack/share', { json: { previewId: 'nope', comment: 'x' } });
    assert.equal(share.status, 404);
    has(await share.json(), ['error'], '/slack/share');
    const login = await asExtension('/slack/login', { json: {} });
    // With an app configured it hands back where to send the browser; without one it says so.
    has(await login.json(), [login.ok ? 'url' : 'error'], '/slack/login');
    has(await (await asExtension('/slack/logout', { json: {} })).json(), ['ok'], '/slack/logout');
  });

  test('/disconnect, then /shutdown last - what the commands report', async () => {
    const d = await bridge.request('/disconnect', { json: { key } });
    has(await d.json(), ['ok', 'already', 'held', 'registered', 'primary'], '/disconnect');
    const s = await bridge.request('/shutdown', { json: {} });
    const j = await s.json();
    has(j, ['ok', 'sessions'], '/shutdown');
    has(j.sessions[0], ['key', 'repo', 'primary', 'detached'], '/shutdown sessions[]');
  });
});
