import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register, startBridge } from './helpers.mjs';

describe('bridge', () => {
  let bridge;
  let key;
  let files;

  before(async () => {
    bridge = await startBridge();
    key = await register(bridge);
    files = fs.mkdtempSync(path.join(bridge.dir, 'files-'));
  });
  after(() => bridge.stop());

  const preview = async (target) => {
    const res = await bridge.request('/preview', { json: { key, target } });
    assert.equal(res.status, 200);
    return res.json();
  };

  describe('control routes', () => {
    test('refuse a caller without the token', async () => {
      for (const route of ['/register', '/preview']) {
        const res = await bridge.request(route, { json: { key, pid: process.pid }, token: null });
        assert.equal(res.status, 401, route);
      }
      assert.equal((await bridge.request(`/events?session=${key}`, { token: null })).status, 401);
    });

    test('/health says only that it is up without the token', async () => {
      const bare = await (await bridge.request('/health', { token: null })).json();
      assert.deepEqual(Object.keys(bare).sort(), ['instance', 'ok']);
      const full = await (await bridge.request('/health')).json();
      assert.ok(full.sessions.some((s) => s.key === key));
    });

    test('refuse a body that is not JSON, which a page could send without a preflight', async () => {
      const res = await bridge.request('/register', {
        body: JSON.stringify({ key, pid: process.pid }), headers: { 'content-type': 'text/plain' },
      });
      assert.equal(res.status, 415);
    });

    test('refuse a Host that is not loopback', async () => {
      const http = await import('node:http');
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: bridge.port, path: '/health', headers: { host: `rebound.example:${bridge.port}` } },
          (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
      });
      assert.equal(status, 421);
    });
  });

  describe('/register', () => {
    test('rejects a key that could escape the scratch directory, and deletes nothing', async () => {
      const victim = fs.mkdtempSync(path.join(bridge.dir, 'victim-'));
      const rel = path.relative(bridge.stateDir, victim);
      for (const k of [rel, '../x', 'p1/../../x', '']) {
        const res = await bridge.request('/register', { json: { key: k, pid: 999999999 } });
        assert.equal(res.status, 400, JSON.stringify(k));
      }
      await bridge.request('/health'); // prunes
      assert.ok(fs.existsSync(victim));
    });

    test('rejects a dead or nonsensical pid', async () => {
      for (const pid of [999999999, -1, 0, 'x']) {
        const res = await bridge.request('/register', { json: { key: 'p12', pid } });
        assert.equal(res.status, 400, String(pid));
      }
    });
  });

  describe('file previews', () => {
    test('the same file keeps its preview id', async () => {
      const file = path.join(files, 'page.html');
      fs.writeFileSync(file, '<html><body><h1>hi</h1></body></html>');
      const a = await preview(file);
      const b = await preview(file);
      assert.equal(a.previewId, b.previewId);
    });

    test('HTML gets both overlay tags, with the repo, before the last </body>', async () => {
      const file = path.join(files, 'inline.html');
      fs.writeFileSync(file, '<html><body><script>const s = "</body>";</script>__ORIGIN__</body></html>');
      const { previewId } = await preview(file);
      const body = await (await bridge.request(`/p/${previewId}/`)).text();
      assert.match(body, /const s = "<\/body>";<\/script>__ORIGIN__<script src="\/console-hook\.js">/);
      assert.match(body, new RegExp(`data-cc-preview="${previewId}" data-cc-origin="${bridge.origin}" data-cc-repo="repo"`));
    });

    test('a PDF whose name has spaces and CJK is served', async () => {
      const name = '報告 final.pdf';
      fs.writeFileSync(path.join(files, name), '%PDF-1.4 test');
      const { previewId } = await preview(path.join(files, name));
      const page = await (await bridge.request(`/p/${previewId}/`)).text();
      assert.match(page, /data-cc-repo="repo"/);
      const src = /src="\.\/(__target\/[^"]+)"/.exec(page)[1];
      const res = await bridge.request(`/p/${previewId}/${src}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '%PDF-1.4 test');
    });

    test('a plain text file shows its text', async () => {
      const file = path.join(files, 'notes.txt');
      fs.writeFileSync(file, 'line <one>');
      const { previewId, kind } = await preview(file);
      assert.equal(kind, 'text');
      assert.match(await (await bridge.request(`/p/${previewId}/`)).text(), /line &lt;one&gt;/);
    });

    test('an id without its trailing slash is redirected to it', async () => {
      const { previewId } = await preview(path.join(files, 'notes.txt'));
      const res = await bridge.request(`/p/${previewId}`);
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), `/p/${previewId}/`);
    });

    test('a path cannot climb out of the preview root', async () => {
      const { previewId } = await preview(path.join(files, 'notes.txt'));
      for (const rel of ['..%2f..%2fetc%2fpasswd', '%2e%2e/%2e%2e/secret']) {
        assert.equal((await bridge.request(`/p/${previewId}/${rel}`)).status, 404, rel);
      }
    });
  });

  describe('/comment', () => {
    const comment = (previewId, extra = {}, headers = {}) => bridge.request('/comment', {
      token: null, headers,
      json: { previewId, comment: 'make it blue', page: { url: 'http://localhost:5173/a?x=1' }, anchor: { kind: 'element' }, ...extra },
    });

    test('numbers per page and never below what the page already shows', async () => {
      const { previewId } = await preview('http://localhost:5173/');
      assert.equal((await (await comment(previewId)).json()).n, 1);
      assert.equal((await (await comment(previewId, { after: 7 })).json()).n, 8);
      assert.equal((await (await comment(previewId, { page: { url: 'http://localhost:5173/b' } })).json()).n, 1);
    });

    test('an automatically bound origin accepts the extension, not the page itself', async () => {
      const origin = 'https://deployed.example';
      const res = await bridge.request(`/resolve?origin=${encodeURIComponent(origin)}`, { token: null });
      const { previewId } = await res.json();
      assert.ok(previewId);
      assert.equal((await comment(previewId, {}, { origin })).status, 403);
      assert.equal((await comment(previewId, {}, { origin: 'chrome-extension://abc' })).status, 200);
    });

    test('an origin opened with /preview accepts the page, for the bookmarklet', async () => {
      const { previewId } = await preview('http://localhost:8123/');
      assert.equal((await comment(previewId, {}, { origin: 'http://localhost:8123' })).status, 200);
      assert.equal((await comment(previewId, {}, { origin: 'http://localhost:9999' })).status, 403);
    });
  });

  describe('/resolve', () => {
    test('refuses web contexts', async () => {
      const q = `/resolve?origin=${encodeURIComponent('https://x.example')}`;
      assert.equal((await bridge.request(q, { token: null, headers: { origin: 'https://x.example' } })).status, 403);
      assert.equal((await bridge.request(q, { token: null, headers: { 'sec-fetch-site': 'same-origin' } })).status, 403);
      assert.equal((await bridge.request(q, { token: null, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal((await bridge.request(q, { token: null, headers: { origin: 'chrome-extension://abc' } })).status, 200);
    });

    test('never binds the bridge origin itself', async () => {
      const res = await bridge.request(`/resolve?origin=${encodeURIComponent(bridge.origin)}`, { token: null });
      assert.equal(res.status, 404);
    });
  });
});

test('previews, counters and seq survive a daemon restart', async () => {
  const first = await startBridge();
  const key = await register(first);
  const res = await first.request('/preview', { json: { key, target: 'http://localhost:7000/' } });
  const { previewId } = await res.json();
  const sent = await first.request('/comment', {
    token: null, json: { previewId, comment: 'one', page: { url: 'http://localhost:7000/' } },
  });
  assert.equal((await sent.json()).n, 1);
  await first.stop();

  const second = await startBridge({ tmp: first.dir, port: first.port });
  try {
    await register(second, key);
    const again = await second.request('/comment', {
      token: null, json: { previewId, comment: 'two', page: { url: 'http://localhost:7000/' } },
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).n, 2);
  } finally {
    await second.stop();
  }
});

/**
 * Two sessions, one dev server. Both ran /preview on it, so both claims are explicit and the
 * tie-break is the one the user can see: the most recent setup gesture owns the browser.
 */
describe('an origin two sessions have opened', () => {
  const site = 'http://localhost:5199';
  let bridge;
  let keyA;
  let keyB;

  before(async () => {
    bridge = await startBridge();
    keyA = await register(bridge, `p${process.pid}`);
    // A second session: the key only has to be a valid one and the pid only has to be alive.
    keyB = await register(bridge, `p${process.pid}1`);
  });
  after(() => bridge.stop());

  // Claims are ordered by the millisecond they were made, so two of them need different ones.
  const claim = async (key) => {
    await new Promise((r) => setTimeout(r, 2));
    const res = await bridge.request('/preview', { json: { key, target: `${site}/` } });
    assert.equal(res.status, 200);
    return (await res.json()).previewId;
  };

  const resolved = async () => {
    const res = await bridge.request(`/resolve?origin=${encodeURIComponent(site)}`, {
      token: null, headers: { origin: 'chrome-extension://abc' },
    });
    assert.equal(res.status, 200);
    return (await res.json()).previewId;
  };

  test('belongs to whichever session opened it last', async () => {
    const a = await claim(keyA);
    const b = await claim(keyB);
    assert.notEqual(a, b); // one preview per (session, origin)
    assert.equal(await resolved(), b);

    // And it goes back when the first session opens it again - the same preview, re-claimed.
    assert.equal(await claim(keyA), a);
    assert.equal(await resolved(), a);
  });
});

/**
 * A comment nobody receives has to say so. The grace period is what makes a monitor that is
 * merely reconnecting harmless, so it is turned off here to test the rule rather than the grace.
 */
describe('a session with nothing listening', () => {
  let bridge;
  let key;

  before(async () => {
    bridge = await startBridge({ env: { LOCAL_ARTIFACT_LISTEN_GRACE_MS: '0' } });
    key = await register(bridge);
  });
  after(() => bridge.stop());

  const comment = (previewId) => bridge.request('/comment', {
    token: null,
    json: { previewId, comment: 'anyone there?', page: { url: 'http://localhost:7100/a' } },
  });

  test('refuses the comment instead of accepting one that goes nowhere', async () => {
    const res = await bridge.request('/preview', { json: { key, target: 'http://localhost:7100/' } });
    const { previewId } = await res.json();

    const nobody = await comment(previewId);
    assert.equal(nobody.status, 409);
    assert.match((await nobody.json()).error, /no Claude session is listening/);

    // With a monitor on the stream, the same comment goes through - and arrives.
    const events = await fetch(`${bridge.origin}/events?session=${key}`, {
      headers: { 'x-cc-token': bridge.token },
    });
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: hello/);

    const sent = await comment(previewId);
    assert.equal(sent.status, 200);
    assert.match(new TextDecoder().decode((await reader.read()).value), /anyone there\?/);
    await reader.cancel();
  });
});

/**
 * The gap a reconnecting monitor leaves: it registers first and opens its stream second, so the
 * grace window has to survive the /register in between - it is the only thing holding the window
 * open once the daemon is older than the grace itself.
 */
describe('a monitor between streams', () => {
  const GRACE = 1200;
  let bridge;
  let key;

  before(async () => {
    bridge = await startBridge({ env: { LOCAL_ARTIFACT_LISTEN_GRACE_MS: String(GRACE) } });
    key = await register(bridge);
  });
  after(() => bridge.stop());

  /** How many monitors the daemon believes are on this session's stream. */
  const clients = async () => {
    const { sessions } = await (await bridge.request('/health')).json();
    return sessions.find((s) => s.key === key)?.clients ?? 0;
  };

  test('a comment is still taken after it re-registers', async () => {
    const res = await bridge.request('/preview', { json: { key, target: 'http://localhost:7200/' } });
    const { previewId } = await res.json();
    // Past the floor a just-started daemon gets, so only lastStream can hold the window open.
    await new Promise((r) => setTimeout(r, GRACE + 50));

    const stream = new AbortController();
    const events = await fetch(`${bridge.origin}/events?session=${key}`, {
      headers: { 'x-cc-token': bridge.token }, signal: stream.signal,
    });
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: hello/);
    stream.abort();
    // Back to back rather than on a timer: each round trip is its own turn of the event loop,
    // and waiting between them would eat into the very window being tested.
    for (let i = 0; i < 100 && await clients() > 0; i++) { /* spin on the round trip itself */ }
    assert.equal(await clients(), 0); // the close is what writes lastStream

    await register(bridge, key); // what a monitor does before reopening the stream
    const sent = await bridge.request('/comment', {
      token: null,
      json: { previewId, comment: 'still here', page: { url: 'http://localhost:7200/a' } },
    });
    assert.equal(sent.status, 200, await sent.text());
  });
});
