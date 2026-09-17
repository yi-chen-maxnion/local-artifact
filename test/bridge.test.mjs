import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { comment, listen, preview, register, startBridge } from './helpers.mjs';

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

    // The one that fails on a developer machine if the helper's config isolation is ever
    // dropped: this daemon asked for no config directory, so it must be looking at an empty
    // one of its own rather than at the real token - which /health would report by name.
    test('a daemon started with no extra env has no Slack connection', async () => {
      const { slack } = await (await bridge.request('/health')).json();
      assert.equal(slack.connected, false);
      assert.equal(slack.user, '');
      assert.equal(slack.team, '');
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
      const a = await preview(bridge, key, file);
      const b = await preview(bridge, key, file);
      assert.equal(a.previewId, b.previewId);
    });

    test('HTML gets both overlay tags, with the repo, before the last </body>', async () => {
      const file = path.join(files, 'inline.html');
      fs.writeFileSync(file, '<html><body><script>const s = "</body>";</script>__ORIGIN__</body></html>');
      const { previewId } = await preview(bridge, key, file);
      const body = await (await bridge.request(`/p/${previewId}/`)).text();
      assert.match(body, /const s = "<\/body>";<\/script>__ORIGIN__<script src="\/console-hook\.js">/);
      assert.match(body, new RegExp(`data-cc-preview="${previewId}" data-cc-origin="${bridge.origin}" data-cc-repo="repo"`));
    });

    test('a PDF whose name has spaces and CJK is served', async () => {
      const name = '報告 final.pdf';
      fs.writeFileSync(path.join(files, name), '%PDF-1.4 test');
      const { previewId } = await preview(bridge, key, path.join(files, name));
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
      const { previewId, kind } = await preview(bridge, key, file);
      assert.equal(kind, 'text');
      assert.match(await (await bridge.request(`/p/${previewId}/`)).text(), /line &lt;one&gt;/);
    });

    test('an id without its trailing slash is redirected to it', async () => {
      const { previewId } = await preview(bridge, key, path.join(files, 'notes.txt'));
      const res = await bridge.request(`/p/${previewId}`);
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), `/p/${previewId}/`);
    });

    test('a path cannot climb out of the preview root', async () => {
      const { previewId } = await preview(bridge, key, path.join(files, 'notes.txt'));
      for (const rel of ['..%2f..%2fetc%2fpasswd', '%2e%2e/%2e%2e/secret']) {
        assert.equal((await bridge.request(`/p/${previewId}/${rel}`)).status, 404, rel);
      }
    });
  });

  describe('/comment', () => {
    let monitor;

    // Every 200 below is a comment that has to be deliverable, so the session needs someone on
    // its stream. Without this these tests only passed while the daemon was young enough for
    // `listening()` to wave them through - a race with how long the file above takes to run.
    before(async () => { monitor = await listen(bridge, key); });
    after(() => monitor.close());

    test('numbers per page and never below what the page already shows', async () => {
      const { previewId } = await preview(bridge, key, 'http://localhost:5173/');
      assert.equal((await (await comment(bridge, previewId)).json()).n, 1);
      assert.equal((await (await comment(bridge, previewId, { after: 7 })).json()).n, 8);
      const other = { page: { url: 'http://localhost:5173/b' } };
      assert.equal((await (await comment(bridge, previewId, other)).json()).n, 1);
    });

    test('an automatically bound origin accepts the extension, not the page itself', async () => {
      const origin = 'https://deployed.example';
      const res = await bridge.request(`/resolve?origin=${encodeURIComponent(origin)}`, { token: null });
      const { previewId } = await res.json();
      assert.ok(previewId);
      assert.equal((await comment(bridge, previewId, { headers: { origin } })).status, 403);
      const ext = { headers: { origin: 'chrome-extension://abc' } };
      assert.equal((await comment(bridge, previewId, ext)).status, 200);
    });

    test('an origin opened with /preview accepts the page, for the bookmarklet', async () => {
      const { previewId } = await preview(bridge, key, 'http://localhost:8123/');
      const page = (origin) => comment(bridge, previewId, { headers: { origin } });
      assert.equal((await page('http://localhost:8123')).status, 200);
      assert.equal((await page('http://localhost:9999')).status, 403);
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
  const page = { url: 'http://localhost:7000/' };
  const first = await startBridge();
  const key = await register(first);
  // The session's monitor, on the daemon that is about to go away.
  const monitor = await listen(first, key);
  const { previewId } = await preview(first, key, 'http://localhost:7000/');
  assert.equal((await (await comment(first, previewId, { comment: 'one', page })).json()).n, 1);
  await monitor.close();
  await first.stop();

  const second = await startBridge({ tmp: first.dir, port: first.port });
  try {
    await register(second, key);
    // What a restart looks like from the session's side: the monitor comes back and reopens its
    // stream on the new daemon. That reconnection, not the new daemon's youth, is what makes the
    // second comment deliverable - the point of the test is the numbering that survived.
    const reconnected = await listen(second, key);
    try {
      const again = await comment(second, previewId, { comment: 'two', page });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).n, 2);
    } finally {
      await reconnected.close();
    }
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
    return (await preview(bridge, key, `${site}/`)).previewId;
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
    // Named rather than left to the helper's default, because the window is what this is about.
    bridge = await startBridge({ env: { LOCAL_ARTIFACT_LISTEN_GRACE_MS: '0' } });
    key = await register(bridge);
  });
  after(() => bridge.stop());

  const ask = (previewId) => comment(bridge, previewId, {
    comment: 'anyone there?', page: { url: 'http://localhost:7100/a' },
  });

  test('refuses the comment instead of accepting one that goes nowhere', async () => {
    const { previewId } = await preview(bridge, key, 'http://localhost:7100/');

    const nobody = await ask(previewId);
    assert.equal(nobody.status, 409);
    assert.match((await nobody.json()).error, /no Claude session is listening/);

    // With a monitor on the stream, the same comment goes through - and arrives.
    const monitor = await listen(bridge, key);
    const sent = await ask(previewId);
    assert.equal(sent.status, 200);
    assert.equal((await monitor.next()).comment, 'anyone there?');
    await monitor.close();
  });
});

/**
 * A screenshot the daemon cannot park on disk - a scratch directory the OS cleaned out from
 * under it, a full disk - used to take the whole comment down with it. The comment is the thing
 * the user typed; the picture is a nicety, and its absence is already something the notification
 * knows how to explain.
 */
describe('a screenshot the bridge cannot save', () => {
  // The smallest thing `decodeShot` accepts: a 1x1 PNG.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let bridge;
  let key;
  let monitor;
  let previewId;

  before(async () => {
    bridge = await startBridge();
    key = await register(bridge);
    // A listener of our own is what makes the comment deliverable - no test daemon has a grace
    // window - and it is also how the delivered event is read back.
    monitor = await listen(bridge, key);
    ({ previewId } = await preview(bridge, key, 'http://localhost:7300/'));
  });
  after(async () => {
    await monitor.close();
    await bridge.stop();
  });

  const send = (fields = {}) => comment(bridge, previewId, {
    comment: 'look at this', page: { url: 'http://localhost:7300/a' }, screenshot: PNG, ...fields,
  });
  const delivered = () => monitor.next();

  test('is still delivered, with the reason in place of the path', async () => {
    // The control: nothing sabotaged, so the same request writes a real file.
    const ok = await send();
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).shot, true);
    const first = await delivered();
    assert.ok(fs.existsSync(first.shot), first.shot);
    assert.equal(first.capture, undefined);

    // A file where the scratch DIRECTORY has to be: the mkdir inside writeShot cannot succeed.
    const scratch = path.join(bridge.stateDir, key);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.writeFileSync(scratch, 'in the way');
    try {
      const res = await send();
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.shot, false);
      const event = await delivered();
      assert.equal(event.shot, null);
      assert.equal(event.capture.bridge, true);
      assert.match(event.capture.error, /^EEXIST: file already exists$/);
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  });

  // `bridge` is the daemon's word about its own disk, and /comment is a route pages call.
  test('a page cannot claim the bridge failed', async () => {
    const res = await send({ screenshot: null, capture: { bridge: true, extension: false, error: 'x' } });
    assert.equal(res.status, 200);
    const event = await delivered();
    assert.equal(event.capture.bridge, undefined);
    // What the overlay does send still arrives as it was.
    assert.deepEqual(event.capture, { extension: false, error: 'x' });
  });
});

/**
 * A flood has to be refused to the page, not swallowed behind a 200. The limit used to live in
 * the monitor, downstream of every answer the person who pressed Send could see: the bridge had
 * already taken the comment, numbered it and closed the panel over it.
 */
describe('more comments in a minute than a session will take', () => {
  let bridge;
  let a;
  let b;

  /** A registered session with a real monitor on its stream and a preview of its own. */
  const session = async (key, target) => {
    await register(bridge, key);
    const monitor = await listen(bridge, key);
    const { previewId } = await preview(bridge, key, target);
    return {
      previewId,
      send: (text) => comment(bridge, previewId, { comment: text, page: { url: `${target}a` } }),
      next: monitor.next,
      cancel: monitor.close,
    };
  };

  before(async () => {
    // Two a minute rather than thirty, so the test does not have to send thirty-one. Each
    // session's own stream is what makes its comments deliverable, as on any test daemon.
    bridge = await startBridge({ env: { LOCAL_ARTIFACT_COMMENT_RATE_MAX: '2' } });
    a = await session(`p${process.pid}`, 'http://localhost:7400/');
    // A second session: as above, the key only has to be a valid one over a live pid.
    b = await session(`p${process.pid}1`, 'http://localhost:7401/');
  });
  after(async () => {
    await a.cancel();
    await b.cancel();
    await bridge.stop();
  });

  test('refuses the ones past it, and spends nothing on a refusal', async () => {
    assert.equal((await (await a.send('one')).json()).n, 1);
    assert.equal((await (await a.send('two')).json()).n, 2);

    const refused = await a.send('three');
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /too many comments in a minute/);

    // Exactly two arrived, numbered 1 and 2 over consecutive sequence numbers - so the refused
    // one took no comment number and no place in the sequence.
    const first = await a.next();
    const second = await a.next();
    assert.deepEqual([first.n, second.n], [1, 2]);
    assert.deepEqual([first.seq, second.seq], [1, 2]);

    // Another session has its own budget: what is being protected is one session's attention.
    const other = await b.send('mine');
    assert.equal(other.status, 200);
    const third = await b.next();
    assert.equal(third.n, 1);
    assert.equal(third.seq, 3); // not 4 - the refusal never reached ++seq
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
    // The one place that wants a window: named here rather than left to the helper's default,
    // which is none. Raising it would buy margin only by lengthening the sleep below by as much.
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
    const { previewId } = await preview(bridge, key, 'http://localhost:7200/');
    // Past the floor a just-started daemon gets, so only lastStream can hold the window open.
    await new Promise((r) => setTimeout(r, GRACE + 50));
    // The first request after an idle gap costs far more than a warm one on this loopback -
    // enough, measured, to eat a second of the window. Spend it here, where the clock the test
    // cares about has not started: that clock starts when the stream below closes.
    await clients();

    // Opened by hand rather than with `listen`: this is the one test about *when* the stream
    // closes, so it wants the abort in its own hand, and it never reads a comment off it.
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
    const sent = await comment(bridge, previewId, {
      comment: 'still here', page: { url: 'http://localhost:7200/a' },
    });
    assert.equal(sent.status, 200, await sent.text());
  });
});
