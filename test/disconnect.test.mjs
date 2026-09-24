import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, comment, connect, freePort, listen, originId, register, seenExtension, startBridge,
} from './helpers.mjs';

/**
 * Turning the bridge off: one session stepping out with /disconnect, and the daemon stopping.
 *
 * The constraint under all of it is that a session's monitor never exits - the host starts it
 * once per session and does not start it again - so a disconnected session still has a monitor
 * re-registering on every reconnect, and the daemon is what has to remember to route it nothing.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A process that is alive until it is killed, to be a session that can end. */
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
const killed = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once('exit', resolve);
  child.kill('SIGKILL');
});
const stateOf = (bridge) => JSON.parse(fs.readFileSync(path.join(bridge.stateDir, `previews-${bridge.port}.json`), 'utf8'));

describe('/disconnect', () => {
  let bridge;
  let mine; // this test process: a session that cannot end under the test
  let other; // a session that stays connected-able, until the restart test ends it
  let otherKey;
  let previewId;

  before(async () => {
    bridge = await startBridge();
    other = sleeper();
    otherKey = `p${other.pid}`;
    await bridge.request('/register', {
      json: { key: otherKey, pid: other.pid, cwd: '/tmp/elsewhere', repo: 'elsewhere' },
    });
    // Registered after `other`, so it is the most recent; the handover has to skip it on purpose.
    mine = await register(bridge);
    await connect(bridge, mine);
    // Minted while someone holds the browser, since /resolve answers nothing otherwise.
    previewId = await originId(bridge, 'http://localhost:7400');
  });
  after(async () => {
    await killed(other);
    await bridge.stop();
  });

  const health = async () => (await bridge.request('/health')).json();
  const flag = async (key) => (await health()).sessions.find((s) => s.key === key)?.detached;
  const disconnect = async (key) => {
    const res = await bridge.request('/disconnect', { json: { key } });
    assert.equal(res.status, 200);
    return res.json();
  };

  // A page can reach this port; stopping a session's comments, or the bridge, is not its to do.
  test('refuses a caller without the token, and a key with no live process behind it', async () => {
    for (const route of ['/disconnect', '/shutdown']) {
      assert.equal((await bridge.request(route, { json: { key: mine }, token: null })).status, 401, route);
    }
    assert.equal((await bridge.request('/disconnect', { json: { key: 'p999999999' } })).status, 400);
    assert.equal((await bridge.request('/disconnect', { json: { key: '../x' } })).status, 400);
  });

  test('hands the browser to the most recently connected session still taking comments', async () => {
    assert.deepEqual(await disconnect(mine), {
      ok: true, already: false, held: true, registered: true, primary: { key: otherKey, repo: 'elsewhere' },
    });
    const h = await health();
    assert.equal(h.primary, otherKey);
    assert.equal(await flag(mine), true);
    assert.equal(await flag(otherKey), false);
  });

  test('or to nobody, and a comment is then refused as it is with nobody connected', async () => {
    const d = await disconnect(otherKey);
    // `mine` is registered and alive, and is the only candidate left - and it asked for nothing.
    assert.equal(d.held, true);
    assert.equal(d.primary, null);
    assert.equal((await health()).primary, null);
    const res = await comment(bridge, previewId, { page: { url: 'http://localhost:7400/a' } });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /^no Claude session is connected - run \/connect$/);
  });

  // The trap the whole design is shaped by: the monitor stays attached and re-registers on every
  // reconnect, and /register hands the browser to whoever registers when nobody holds it.
  test('a disconnected session re-registering, as its monitor does, does not take the browser back', async () => {
    await register(bridge, mine);
    await bridge.request('/register', {
      json: { key: otherKey, pid: other.pid, cwd: '/tmp/elsewhere', repo: 'elsewhere' },
    });
    assert.equal((await health()).primary, null);
  });

  test('disconnecting again changes nothing and says so', async () => {
    assert.deepEqual(await disconnect(mine), {
      ok: true, already: true, held: false, registered: true, primary: null,
    });
    assert.equal(await flag(mine), true);
  });

  test('/connect is the way back', async () => {
    await connect(bridge, mine);
    assert.equal((await health()).primary, mine);
    assert.equal(await flag(mine), false);
  });

  // The other handover: the holder ends, and pruning looks for someone to pass the browser to.
  test('a session that ends does not hand the browser to one that disconnected', async () => {
    const third = sleeper();
    try {
      await register(bridge, `p${third.pid}`, third.pid);
      await connect(bridge, `p${third.pid}`);
      await disconnect(mine); // did not hold it; is now registered most recently but for `third`
      await killed(third);
      assert.equal((await health()).primary, null);
    } finally {
      await killed(third);
    }
  });

  /**
   * Sessions are not persisted - monitors re-register after a restart - so without this a
   * restarted daemon would let the first reconnecting monitor take the browser, disconnected or
   * not. An ended session goes from the file with its pid.
   */
  test('survives a daemon restart, and an ended session is dropped from it', async () => {
    await killed(other); // detached, and now dead - no prune has run since
    await bridge.stop();
    bridge = await startBridge({ tmp: bridge.dir, port: bridge.port });

    await register(bridge, mine); // the monitor, coming back to the new daemon
    assert.equal((await health()).primary, null);
    assert.equal(await flag(mine), true);
    // Written out again by the new daemon, which is the only way to see what it kept.
    assert.equal((await disconnect(mine)).already, true);
    assert.deepEqual(stateOf(bridge).detached.map(([key]) => key), [mine]);

    await connect(bridge, mine);
    assert.deepEqual(stateOf(bridge).detached, []);
  });
});

describe('stopping the bridge', () => {
  const tokenOf = (bridge) => path.join(bridge.stateDir, `token-${bridge.port}`);
  const exit = (bridge) => new Promise((resolve) => {
    bridge.child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
  });

  /**
   * A value the daemon holds in memory and writes out lazily: the extension's second sighting
   * inside a minute is not saved. What the state file says after a stop is therefore what the
   * shutdown itself wrote.
   */
  const unsaved = async (bridge) => {
    await seenExtension(bridge);
    await sleep(5);
    await seenExtension(bridge);
    const { extension } = await (await bridge.request('/health')).json();
    assert.notEqual(stateOf(bridge).extensionSeenAt, extension.seenAt, 'already saved - this proves nothing');
    return extension.seenAt;
  };

  test('/shutdown answers with who was connected, says bye to every stream, saves, and exits 0', async () => {
    const bridge = await startBridge();
    try {
      const key = await register(bridge);
      await connect(bridge, key);
      const seenAt = await unsaved(bridge);
      const monitor = await listen(bridge, key);
      const exited = exit(bridge);
      const t0 = Date.now();

      const res = await bridge.request('/shutdown', { json: {} });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true, sessions: [{ key, repo: 'repo', primary: true, detached: false }],
      });
      assert.deepEqual(await monitor.bye(), { reason: 'shutdown' });
      assert.equal(await monitor.ended(), true);

      const { code, signal, at } = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
      // Well inside the hard fallback, which exits 0 too: this is the orderly path finishing.
      assert.ok(at - t0 < 2000, `took ${at - t0}ms`);
      assert.equal(stateOf(bridge).extensionSeenAt, seenAt);
      assert.equal(fs.existsSync(tokenOf(bridge)), false);
      await assert.rejects(fetch(`${bridge.origin}/health`));
    } finally {
      await bridge.stop();
    }
  });

  // The same routine, from a signal - twice, since one can arrive in the middle of the other.
  test('SIGTERM does the same, and a second one changes nothing', async () => {
    const bridge = await startBridge();
    try {
      const key = await register(bridge);
      const seenAt = await unsaved(bridge);
      const monitor = await listen(bridge, key);
      const exited = exit(bridge);
      bridge.child.kill('SIGTERM');
      bridge.child.kill('SIGTERM');
      // Not `shutdown`: a signal is also how a daemon running older code is replaced, and the
      // monitors should come straight back to the new one rather than wait on the slow retry.
      assert.deepEqual(await monitor.bye(), { reason: 'signal' });
      const { code, signal } = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(stateOf(bridge).extensionSeenAt, seenAt);
      assert.equal(fs.existsSync(tokenOf(bridge)), false);
    } finally {
      await bridge.stop();
    }
  });

  // A daemon started the moment this one let go of the port has written its own token there.
  test('leaves a token file that is no longer its own', async () => {
    const bridge = await startBridge();
    try {
      const exited = exit(bridge);
      fs.writeFileSync(tokenOf(bridge), 'someone-else');
      // The request carries the token this daemon was started with, which is still its own.
      assert.equal((await bridge.request('/shutdown', { json: {} })).status, 200);
      assert.equal((await exited).code, 0);
      assert.equal(fs.readFileSync(tokenOf(bridge), 'utf8'), 'someone-else');
    } finally {
      await bridge.stop();
    }
  });
});

/**
 * Started between the fake `claude` process and the script, as in test/open.test.mjs: the session
 * key is the pid of that `claude` ancestor, and a test has to set that session up BEFORE the
 * script looks at it. The launcher waits for a line on stdin, so the pid is known and the setup is
 * done by the time anything runs.
 */
const LAUNCH = `import { spawn } from 'node:child_process';
process.stdin.once('data', () => {
  const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
});
`;

describe('scripts/disconnect.mjs and ctl.mjs stop', () => {
  const DISCONNECT = path.join(ROOT, 'scripts', 'disconnect.mjs');
  const CTL = path.join(ROOT, 'scripts', 'ctl.mjs');
  let bridge;
  let claude;
  let launch;
  const elsewhere = `p${process.pid}`; // another session, alive for the whole suite

  before(async () => {
    bridge = await startBridge();
    const dir = fs.mkdtempSync(path.join(bridge.dir, 'session-'));
    claude = path.join(dir, 'claude');
    fs.symlinkSync(process.execPath, claude);
    launch = path.join(dir, 'launch.mjs');
    fs.writeFileSync(launch, LAUNCH);
    await bridge.request('/register', {
      json: { key: elsewhere, pid: process.pid, cwd: '/tmp/elsewhere', repo: 'elsewhere' },
    });
  });
  after(() => bridge.stop());

  /** The script as a session runs it; `setup` gets the key it will resolve for itself. */
  const run = (script, args, { on = bridge, port = on.port, setup } = {}) => new Promise((resolve, reject) => {
    const child = spawn(claude, [launch, script, ...args], {
      env: { ...process.env, LOCAL_ARTIFACT_PORT: String(port), TMPDIR: on.dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err, key: `p${child.pid}` }));
    Promise.resolve(setup?.(`p${child.pid}`, child.pid)).then(() => child.stdin.end('go\n'), reject);
  });
  /** Registers the script's own session and makes it the one the browser reports to. */
  const connected = async (key, pid) => {
    await register(bridge, key, pid);
    await connect(bridge, key);
  };
  const lines = (out) => out.trimEnd().split('\n');

  test('with no bridge running, says there is nothing to do and starts nothing', async () => {
    const port = await freePort();
    const { code, out } = await run(DISCONNECT, [], { port });
    assert.equal(code, 0);
    assert.equal(out, 'disconnect  nothing to do - the bridge is not running, so no session receives comments\n');
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });

  test('refuses an argument it does not take', async () => {
    const { code, err } = await run(DISCONNECT, ['--now']);
    assert.equal(code, 2);
    assert.match(err, /^disconnect: usage: \/disconnect \[--stop\]/);
  });

  test('says where the comments go now that this session has let go of the browser', async () => {
    const { code, out } = await run(DISCONNECT, [], { setup: connected });
    assert.equal(code, 0);
    const said = lines(out);
    assert.match(said[0], /^disconnect {2}session p\d+ \(.*\) - receives no comments from now on$/);
    assert.equal(said[1], '   browser  comments now go to elsewhere, the session connected most recently');
    assert.equal(said[2], '            /connect here takes the browser back.');
  });

  test('run twice, it changes nothing and says so', async () => {
    const { code, out } = await run(DISCONNECT, [], {
      setup: async (key, pid) => {
        await connected(key, pid);
        await bridge.request('/disconnect', { json: { key } });
      },
    });
    assert.equal(code, 0);
    assert.match(lines(out)[0], / - already disconnected; nothing changed$/);
    assert.equal(lines(out)[1], '   browser  comments go to elsewhere, as before');
  });

  test('/comments in a disconnected session says so on the browser line', async () => {
    const { code, out } = await run(CTL, ['status'], {
      setup: async (key, pid) => {
        await register(bridge, key, pid);
        await connect(bridge, elsewhere);
        await bridge.request('/disconnect', { json: { key } });
      },
    });
    assert.equal(code, 0);
    assert.match(out, /^browser {4}not this session - disconnected; \/connect to take it back \(comments go to elsewhere\)$/m);
    assert.match(out, /^sessions {3}.*\(disconnected\)/m);
  });

  test('--stop disconnects, stops the bridge, and names who lost their comments', async () => {
    const exited = new Promise((resolve) => bridge.child.once('exit', resolve));
    const { code, out, err } = await run(DISCONNECT, ['--stop'], { setup: connected });
    assert.equal(code, 0, err);
    const said = lines(out);
    assert.match(said[0], / - receives no comments from now on$/);
    assert.equal(said[1], '      stop  stopped the bridge; 1 other session loses comments until someone runs /connect: elsewhere');
    assert.equal(said.length, 2);
    assert.equal(await exited, 0);
    await assert.rejects(fetch(`${bridge.origin}/health`));
  });

  test('ctl.mjs stop stops it the same way', async () => {
    const other = await startBridge();
    try {
      await other.request('/register', {
        json: { key: elsewhere, pid: process.pid, cwd: '/tmp/elsewhere', repo: 'elsewhere' },
      });
      const exited = new Promise((resolve) => other.child.once('exit', resolve));
      const { code, out } = await run(CTL, ['stop'], { on: other });
      assert.equal(code, 0);
      assert.equal(out, 'bridge     stopped the bridge; 1 other session loses comments until someone runs /connect: elsewhere\n');
      assert.equal(await exited, 0);
    } finally {
      await other.stop();
    }
  });
});
