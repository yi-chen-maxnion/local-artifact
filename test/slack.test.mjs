import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { comment, listen, preview, register, startBridge } from './helpers.mjs';

/**
 * A Slack that records what it was asked for. Every method the bridge calls answers here, so a
 * test can assert on the shape of the exchange - that the token swap carries a code verifier and
 * no client secret, that both files go up before the message, that the text is escaped.
 */
async function startFakeSlack() {
  const calls = [];
  const uploads = new Map(); // upload path -> { filename, body }
  let fail = null; // { methods, error } - the next call to each answers with this Slack error
  let pages = 0; // when set, users.list answers with this many cursor-linked pages instead

  /**
   * A gate the named methods can only pass through together, so "both were asked for before
   * either was answered" is something a test can assert rather than time. It gives up after a
   * moment and lets them through, because a loader that goes one at a time should fail the
   * assertion rather than hang the suite.
   */
  let gate = null; // { methods, seen, waiters, release }
  const openGate = (methods, ms = 1000) => new Promise((resolve) => {
    const waiters = [];
    const timer = setTimeout(() => gate?.release(false), ms);
    const release = (ok) => {
      gate = null;
      clearTimeout(timer);
      for (const w of waiters.splice(0)) w();
      resolve(ok);
    };
    gate = { methods, seen: new Set(), waiters, release };
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://slack.test');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const reply = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname.startsWith('/upload/')) {
      const up = uploads.get(url.pathname);
      if (up) up.body = raw;
      res.writeHead(200);
      return res.end('OK');
    }

    const method = url.pathname.replace(/^\/api\//, '');
    const params = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    calls.push({ method, params, auth: req.headers.authorization || '' });

    if (fail?.methods.includes(method)) {
      const { error, methods } = fail;
      fail = methods.length > 1 ? { error, methods: methods.filter((m) => m !== method) } : null;
      return reply({ ok: false, error });
    }

    if (gate?.methods.includes(method)) {
      const g = gate;
      g.seen.add(method);
      if (g.methods.every((m) => g.seen.has(m))) g.release(true);
      else await new Promise((r) => g.waiters.push(r));
    }

    switch (method) {
      case 'oauth.v2.access':
        return reply({
          ok: true,
          team: { id: 'T1', name: 'Maxnion' },
          authed_user: { id: 'U1', access_token: 'xoxp-test', scope: 'chat:write,files:write' },
        });
      case 'auth.revoke':
        return reply({ ok: true, revoked: true });
      case 'users.info':
        return reply({ ok: true, user: { profile: { display_name: 'yi' }, name: 'yi.chen' } });
      case 'users.conversations':
        return reply({
          ok: true,
          channels: [
            { id: 'C1', name: 'design-review', is_private: false },
            { id: 'C2', name: 'secret-plans', is_private: true },
            { id: 'D1', is_im: true, user: 'U2' },
            { id: 'G1', is_mpim: true, name: 'mpdm-yi--ana--bo-1' },
          ],
        });
      case 'users.list': {
        if (pages) {
          const at = Number(params.cursor || 1);
          return reply({
            ok: true,
            members: [{ id: `U1${at}`, name: `filler-${at}`, profile: {} }],
            ...(at < pages ? { response_metadata: { next_cursor: String(at + 1) } } : {}),
          });
        }
        return reply({
          ok: true,
          members: [
            { id: 'U1', name: 'yi.chen', profile: { display_name: 'yi' } },
            { id: 'U2', name: 'ana', profile: { display_name: 'ana' } },
            { id: 'U3', name: 'bo', profile: { display_name: 'bo' } },
            { id: 'U9', name: 'deleted', deleted: true, profile: {} },
            { id: 'B1', name: 'a-bot', is_bot: true, profile: {} },
          ],
        });
      }
      case 'conversations.open':
        return reply({ ok: true, channel: { id: `D-${params.users}` } });
      case 'chat.postMessage':
        return reply({ ok: true, channel: params.channel, ts: '1700000000.000100' });
      case 'files.getUploadURLExternal': {
        const id = `F${uploads.size + 1}`;
        const at = `/upload/${id}`;
        uploads.set(at, {
          filename: params.filename,
          length: Number(params.length),
          snippet_type: params.snippet_type,
          body: null,
        });
        return reply({ ok: true, upload_url: `${base}${at}`, file_id: id });
      }
      case 'files.completeUploadExternal':
        return reply({ ok: true, files: JSON.parse(params.files) });
      default:
        return reply({ ok: false, error: 'unknown_method' });
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    api: `${base}/api`,
    authorize: `${base}/oauth/authorize`,
    calls,
    uploads,
    // One method, or several that should each fail once - as when two requests are in flight.
    failNext: (method, error) => { fail = { methods: [method].flat(), error }; },
    usersPages: (n) => { pages = n; },
    together: openGate,
    reset: () => { calls.length = 0; uploads.clear(); fail = null; pages = 0; gate?.release(false); },
    stop: () => new Promise((r) => server.close(r)),
  };
}

describe('slack', () => {
  let slack;
  let bridge;
  let key;
  let config;

  before(async () => {
    slack = await startFakeSlack();
    // Never the real one: that is where a real token lives.
    config = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-slack-config-'));
    bridge = await startBridge({
      env: {
        LOCAL_ARTIFACT_SLACK_API: slack.api,
        LOCAL_ARTIFACT_SLACK_AUTHORIZE: slack.authorize,
        LOCAL_ARTIFACT_SLACK_CLIENT_ID: '123.456',
        LOCAL_ARTIFACT_CONFIG_DIR: config,
      },
    });
    key = await register(bridge);
  });
  after(async () => {
    await bridge.stop();
    await slack.stop();
    fs.rmSync(config, { recursive: true, force: true });
  });

  /** The id of a preview on this suite's session - the only part of it /slack/share needs. */
  const opened = async (target = 'http://localhost:5173/') =>
    (await preview(bridge, key, target)).previewId;

  /** The login the panel's Slack side needs: authorize, then the callback Slack would make. */
  const login = async () => {
    const start = await (await bridge.request('/slack/login', { json: {} })).json();
    const state = new URL(start.url).searchParams.get('state');
    return bridge.request(`/slack/callback?code=abc&state=${encodeURIComponent(state)}`, { token: null });
  };

  const share = (previewId, extra = {}, headers = { origin: 'chrome-extension://abc' }) =>
    bridge.request('/slack/share', {
      token: null,
      headers,
      json: {
        previewId,
        comment: 'make it blue',
        dest: { id: 'C1', kind: 'channel', label: '#design-review' },
        page: { url: 'http://localhost:5173/a#/route', title: 'Home' },
        anchor: { kind: 'element', selector: 'button.save', html: '<button class="save">Save</button>' },
        ...extra,
      },
    });

  describe('login', () => {
    beforeEach(() => slack.reset());

    test('can be started from the extension, but never from a web page', async () => {
      // The toolbar menu connects Slack, so these are not control routes - but a page must not
      // be able to connect, disconnect, or learn whose account this browser is holding.
      for (const route of ['/slack/login', '/slack/logout', '/slack/status']) {
        const res = await bridge.request(route, {
          json: {}, token: null, headers: { origin: 'https://deployed.example' },
        });
        assert.equal(res.status, 403, route);
      }
      const ext = { origin: 'chrome-extension://abc' };
      assert.equal((await bridge.request('/slack/status', { token: null, headers: ext })).status, 200);
      const start = await bridge.request('/slack/login', { json: {}, token: null, headers: ext });
      assert.equal(start.status, 200);
      assert.match((await start.json()).url, /code_challenge=/);
    });

    test('status says whether there is an app and a connection, and never more', async () => {
      const s = await (await bridge.request('/slack/status', {
        token: null, headers: { origin: 'chrome-extension://abc' },
      })).json();
      assert.deepEqual(Object.keys(s).sort(), ['configured', 'connected', 'team', 'user']);
    });

    test('swaps the code with a verifier and no client secret, and keeps the token 0600', async () => {
      const res = await login();
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Connected as yi/);

      const swap = slack.calls.find((c) => c.method === 'oauth.v2.access');
      assert.equal(swap.params.client_id, '123.456');
      assert.ok(swap.params.code_verifier, 'a PKCE verifier is sent');
      assert.equal(swap.params.client_secret, undefined, 'a public client has no secret to send');

      const file = path.join(config, 'slack-token.json');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'xoxp-test');

      const health = await (await bridge.request('/health')).json();
      assert.deepEqual(
        { connected: health.slack.connected, user: health.slack.user },
        { connected: true, user: 'yi' },
      );
    });

    test('a state that was never issued, or issued once, is refused', async () => {
      const start = await (await bridge.request('/slack/login', { json: {} })).json();
      const state = new URL(start.url).searchParams.get('state');
      assert.equal((await bridge.request('/slack/callback?code=a&state=forged', { token: null })).status, 400);
      assert.equal((await bridge.request(`/slack/callback?code=a&state=${state}`, { token: null })).status, 200);
      // The same code coming back twice is a replay, not a second login.
      assert.equal((await bridge.request(`/slack/callback?code=a&state=${state}`, { token: null })).status, 400);
    });

    test('the authorize URL asks for user scopes and a loopback redirect', async () => {
      const { url } = await (await bridge.request('/slack/login', { json: {} })).json();
      const u = new URL(url);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('redirect_uri'), `http://localhost:${bridge.port}/slack/callback`);
      assert.equal(u.searchParams.get('scope'), null, 'no bot scopes: a desktop redirect cannot have them');
      const scopes = u.searchParams.get('user_scope').split(',');
      assert.ok(scopes.includes('files:write') && scopes.includes('chat:write'));
      assert.ok(!scopes.some((s) => s.endsWith(':history')), 'nothing that could read a conversation');
    });
  });

  describe('destinations', () => {
    before(login);
    beforeEach(() => slack.reset());

    const list = (q = '', headers = { origin: 'chrome-extension://abc' }) =>
      bridge.request(`/slack/destinations?q=${encodeURIComponent(q)}`, { token: null, headers });

    test('are the extension\'s to ask for, not a page\'s', async () => {
      assert.equal((await list('', { origin: 'https://deployed.example' })).status, 403);
      assert.equal((await list('', { 'sec-fetch-site': 'same-origin' })).status, 403);
      assert.equal((await list()).status, 200);
    });

    test('name channels and people, including someone with no DM yet', async () => {
      const { rows } = await (await list()).json();
      const labels = rows.map((r) => r.label);
      assert.ok(labels.includes('#design-review'));
      assert.ok(labels.includes('#secret-plans'));
      assert.ok(labels.includes('@ana'), 'an existing DM is named after the person');
      assert.ok(labels.includes('yi, ana, bo'), 'a group DM is named after who is in it');
      const bo = rows.find((r) => r.label === '@bo');
      assert.equal(bo.kind, 'user', 'someone with no DM yet is still a destination');
      assert.ok(!labels.includes('@a-bot') && !labels.includes('@deleted'));
    });

    test('filter on what was typed', async () => {
      const { rows } = await (await list('design')).json();
      assert.deepEqual(rows.map((r) => r.label), ['#design-review']);
    });

    test('# is channels and @ is people, as the search box promises', async () => {
      const channels = (await (await list('#')).json()).rows;
      assert.ok(channels.length && channels.every((r) => r.label.startsWith('#')));
      const people = (await (await list('@')).json()).rows;
      assert.ok(people.length && people.every((r) => r.kind !== 'channel' && r.kind !== 'private'));
      // The prefix narrows the kind; what follows it still searches the name.
      assert.deepEqual((await (await list('#design')).json()).rows.map((r) => r.label), ['#design-review']);
      // A group DM with bo in it matches "bo" too, and should - it is still a way to reach them.
      assert.deepEqual((await (await list('@bo')).json()).rows.map((r) => r.label), ['@bo', 'yi, ana, bo']);
      assert.deepEqual((await (await list('#bo')).json()).rows, [], 'a person is not a channel');
    });

    test('ask for the two lists at once, not one chain after the other', async () => {
      await login(); // a fresh login drops the cached lists, so both chains really run
      const together = slack.together(['users.conversations', 'users.list']);
      assert.equal((await list()).status, 200);
      assert.equal(await together, true, 'neither list was answered before the other was asked for');
    });

    test('both failing is one error, and the daemon lives through it', async () => {
      await login();
      slack.failNext(['users.conversations', 'users.list'], 'ratelimited');
      const res = await list();
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /rate limiting/);
      // Whichever rejection lost the race was still handled - an unhandled one would have taken
      // the bridge with it, and nothing cached the half-list that came back before the failure.
      assert.equal((await list()).status, 200);
    });

    test('say when Slack had more to give, rather than lose a colleague quietly', async () => {
      slack.usersPages(7); // more pages than the loader will follow
      await login();
      const j = await (await list()).json();
      assert.equal(j.truncated, true);
      assert.ok(j.rows.length, 'and what did arrive is still offered');
    });

    test('a list that fitted is not flagged', async () => {
      await login();
      assert.equal((await (await list()).json()).truncated, false);
    });
  });

  describe('an expiring token', () => {
    before(login);
    beforeEach(() => slack.reset());

    test('is swapped before it is used, without a client secret', async () => {
      const file = path.join(config, 'slack-token.json');
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({
        ...t, token: 'xoxp-stale', refreshToken: 'xoxe-1', expiresAt: Date.now() - 1000,
      }), { mode: 0o600 });

      const previewId = await opened();
      assert.equal((await share(previewId)).status, 200);

      const refresh = slack.calls.find((c) => c.method === 'oauth.v2.access');
      assert.equal(refresh.params.grant_type, 'refresh_token');
      assert.equal(refresh.params.refresh_token, 'xoxe-1');
      assert.equal(refresh.params.client_secret, undefined);

      const post = slack.calls.find((c) => c.method === 'chat.postMessage');
      assert.equal(post.auth, 'Bearer xoxp-test', 'the refreshed token is the one that posts');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'xoxp-test');
    });

    test('that Slack will not refresh is reported as a login to run', async () => {
      const file = path.join(config, 'slack-token.json');
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({
        ...t, refreshToken: 'xoxe-dead', expiresAt: Date.now() - 1000,
      }), { mode: 0o600 });
      slack.failNext('oauth.v2.access', 'invalid_refresh_token');

      const res = await share(await opened());
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /\/slack login/);
      await login(); // leave the suite connected for what follows
    });
  });

  describe('sharing', () => {
    before(login);
    beforeEach(() => slack.reset());

    /** The message, however it went: attached to an upload, or posted on its own. */
    const posted = () => {
      const c = slack.calls.find((x) => x.method === 'files.completeUploadExternal')
        || slack.calls.find((x) => x.method === 'chat.postMessage');
      return { ...c, text: c.params.initial_comment ?? c.params.text };
    };

    test('uploads the screenshot and hangs the whole message on it', async () => {
      const previewId = await opened();
      const shot = `data:image/jpeg;base64,${Buffer.from('not really a jpeg').toString('base64')}`;
      const res = await share(previewId, { screenshot: shot });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, label: '#design-review' });

      // One attachment, and it is the picture: the detail is in the message itself.
      assert.deepEqual([...slack.uploads.values()].map((u) => u.filename), ['screenshot.jpg']);
      const [jpg] = [...slack.uploads.values()];
      assert.equal(jpg.body.toString('utf8'), 'not really a jpeg');
      assert.equal(jpg.length, jpg.body.length, 'the length told to Slack is the length sent');

      const post = posted();
      assert.equal(post.params.channel_id, 'C1');
      assert.equal(post.auth, 'Bearer xoxp-test');
      assert.deepEqual(JSON.parse(post.params.files).map((f) => f.id), ['F1']);

      const text = post.params.initial_comment;
      assert.match(text, /^> make it blue\n/);
      assert.match(text, /🔗 {2}<http:\/\/localhost:5173\/a#\/route>/);
      assert.match(text, /```[\s\S]*selector {2}button\.save[\s\S]*```/);
      assert.ok(!text.includes(bridge.dir), 'nor does any path on this machine');
    });

    test('escapes what Slack would otherwise read as a mention', async () => {
      const previewId = await opened();
      await share(previewId, { comment: 'ping <!channel> about <https://x> & co' });
      const { text } = posted();
      assert.match(text, /&lt;!channel&gt;/);
      assert.ok(!/<!channel>/.test(text));
      assert.match(text, /&amp; co/);
    });

    test('opens a DM first when the destination is a person', async () => {
      const previewId = await opened();
      const res = await share(previewId, { dest: { id: 'U3', kind: 'user', label: '@bo' } });
      assert.equal(res.status, 200);
      assert.equal(slack.calls.find((c) => c.method === 'conversations.open').params.users, 'U3');
      assert.equal(posted().params.channel, 'D-U3');
    });

    test('with no screenshot there is nothing to upload, so it posts a message', async () => {
      const previewId = await opened();
      assert.equal((await share(previewId)).status, 200);
      assert.equal(slack.uploads.size, 0);
      const post = posted();
      assert.equal(post.params.channel, 'C1');
      assert.match(post.text, /^> make it blue\n/);
    });

    test('a comment is optional - the picture and the page can be the whole point', async () => {
      const previewId = await opened();
      assert.equal((await share(previewId, { comment: '   ' })).status, 200);
      const { text } = posted();
      assert.match(text, /^🔗/, 'no empty quote line where the comment would have been');
    });

    test('tells the session nothing - that is what Send is for', async () => {
      const previewId = await opened();
      // A live monitor: the stream is what a shared comment would have travelled down, and it is
      // also what makes the /comment at the end deliverable, so it stays open to the end.
      const monitor = await listen(bridge, key);
      const delivered = monitor.next();

      await share(previewId);
      const nothing = await Promise.race([
        delivered,
        new Promise((r) => setTimeout(() => r('(nothing)'), 700)),
      ]);
      assert.equal(nothing, '(nothing)', 'no comment event reaches the monitor');

      // And the page's comment numbering is untouched: the next Send is still #1.
      const sent = await comment(bridge, previewId, {
        headers: { origin: 'chrome-extension://abc' },
        comment: 'and to the session',
        page: { url: 'http://localhost:5173/a' },
      });
      assert.equal((await sent.json()).n, 1);
      // The same waiting read, resolved by the Send rather than by the share.
      assert.equal((await delivered).comment, 'and to the session');
      await monitor.close();
    });

    test('is the extension\'s to ask for, and only for a page that is bound', async () => {
      const previewId = await opened();
      assert.equal((await share(previewId, {}, { origin: 'https://deployed.example' })).status, 403);
      assert.equal((await share('deadbeef')).status, 404);
    });

    test('a Slack error comes back as the thing to do about it', async () => {
      const previewId = await opened();
      slack.failNext('chat.postMessage', 'not_in_channel');
      const res = await share(previewId);
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /not in that channel/);

      const health = await (await bridge.request('/health')).json();
      assert.equal(health.slack.last.ok, false);
      assert.match(health.slack.last.error, /not in that channel/);
    });

    test('stops runaway posting', async () => {
      const previewId = await opened();
      const codes = [];
      for (let i = 0; i < 12; i++) codes.push((await share(previewId)).status);
      assert.ok(codes.includes(429), 'the eleventh post in a minute is refused');
    });
  });

  describe('logout', () => {
    test('revokes at Slack and forgets the token here', async () => {
      await login();
      slack.reset();
      assert.equal((await bridge.request('/slack/logout', { json: {} })).status, 200);
      assert.ok(slack.calls.some((c) => c.method === 'auth.revoke'));
      assert.equal(fs.existsSync(path.join(config, 'slack-token.json')), false);

      const health = await (await bridge.request('/health')).json();
      assert.equal(health.slack.connected, false);
      // And the panel is no longer offered it.
      const resolved = await bridge.request('/resolve?origin=https%3A%2F%2Fdeployed.example', { token: null });
      assert.deepEqual((await resolved.json()).slack, { connected: false });
    });
  });
});

/**
 * Its own bridge and its own config directory, because the only way to fail a write from outside
 * the daemon is to take the directory away - `writeFileAtomic` lays its temp file down next to the
 * target - and the suite above shares one config directory that later tests still need to write.
 */
describe('a refresh Slack granted but the disk would not keep', () => {
  let slack;
  let bridge;
  let key;
  let config;

  before(async () => {
    slack = await startFakeSlack();
    config = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-slack-ro-'));
    bridge = await startBridge({
      env: {
        LOCAL_ARTIFACT_SLACK_API: slack.api,
        LOCAL_ARTIFACT_SLACK_AUTHORIZE: slack.authorize,
        LOCAL_ARTIFACT_SLACK_CLIENT_ID: '123.456',
        LOCAL_ARTIFACT_CONFIG_DIR: config,
      },
    });
    key = await register(bridge);
    const start = await (await bridge.request('/slack/login', { json: {} })).json();
    const state = new URL(start.url).searchParams.get('state');
    await bridge.request(`/slack/callback?code=abc&state=${encodeURIComponent(state)}`, { token: null });
  });
  after(async () => {
    // Whatever happened above, the directory has to be removable again.
    try { fs.chmodSync(config, 0o700); } catch {}
    await bridge.stop();
    await slack.stop();
    fs.rmSync(config, { recursive: true, force: true });
  });

  const share = async () => {
    const { previewId } = await preview(bridge, key, 'http://localhost:5173/');
    return bridge.request('/slack/share', {
      token: null,
      headers: { origin: 'chrome-extension://abc' },
      json: {
        previewId,
        comment: 'make it blue',
        dest: { id: 'C1', kind: 'channel', label: '#design-review' },
        page: { url: 'http://localhost:5173/a' },
      },
    });
  };

  test('posts the comment anyway, and goes on working without the file', async () => {
    const file = path.join(config, 'slack-token.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({
      ...t, token: 'xoxp-stale', refreshToken: 'xoxe-1', expiresAt: Date.now() - 1000,
    }), { mode: 0o600 });
    slack.reset();

    let res;
    try {
      fs.chmodSync(config, 0o500); // nothing new may be created here, so the atomic write's temp file fails
      res = await share();
    } finally {
      fs.chmodSync(config, 0o700);
    }

    // The refresh token was spent on a token that works; the comment must not be what pays for
    // the daemon being unable to write it down.
    assert.equal(res.status, 200, 'the share is not lost');
    assert.equal(
      slack.calls.find((c) => c.method === 'chat.postMessage').auth,
      'Bearer xoxp-test',
      'and it posts with the token the refresh returned',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(file, 'utf8')).token, 'xoxp-stale',
      'the write really did fail - this is not a test that passes for the wrong reason',
    );

    // Held in memory, so the next share neither spends the dead refresh token nor asks for a login.
    slack.reset();
    assert.equal((await share()).status, 200);
    assert.equal(slack.calls.filter((c) => c.method === 'oauth.v2.access').length, 0);
    assert.equal(slack.calls.find((c) => c.method === 'chat.postMessage').auth, 'Bearer xoxp-test');
  });
});
