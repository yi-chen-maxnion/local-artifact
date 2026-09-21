import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, connect, freePort, listen, register, seenExtension, startBridge } from './helpers.mjs';

/**
 * The precondition ladder in scripts/open.mjs, rung by rung.
 *
 * Opening a file is the one thing Claude does here on its own initiative, so every way it can be
 * wrong has to be loud: a file that arrives in a browser whose comments reach nobody looks exactly
 * like one that worked, and the user only finds out by commenting into the void. Each test below
 * is one rung - the exit code, and the first line of stderr, which is what a session relays.
 */

/**
 * Started between the fake `claude` process and open.mjs, for one reason: the session key is the
 * pid of that `claude` ancestor, and a test has to be able to register that session BEFORE the
 * script looks it up. The launcher waits for a line on stdin, so the pid is known and the setup
 * is done by the time anything runs. open.mjs inherits its stdio, so what these tests read is
 * what a session would.
 */
const LAUNCH = `import { spawn } from 'node:child_process';
process.stdin.once('data', () => {
  const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
});
`;

describe('scripts/open.mjs', () => {
  const SCRIPT = path.join(ROOT, 'scripts', 'open.mjs');
  let bridge;
  let claude; // node under the name `claude`: what findClaudePid walks up to
  let launch;
  let files;
  let report;

  before(async () => {
    bridge = await startBridge();
    const dir = fs.mkdtempSync(path.join(bridge.dir, 'session-'));
    claude = path.join(dir, 'claude');
    // A symlink, not a copy: `ps` prints the name a process was started under, which is all
    // findClaudePid reads - the same trick test/monitor.test.mjs uses.
    fs.symlinkSync(process.execPath, claude);
    launch = path.join(dir, 'launch.mjs');
    fs.writeFileSync(launch, LAUNCH);
    files = fs.mkdtempSync(path.join(bridge.dir, 'files-'));
    report = path.join(files, 'report.html');
    fs.writeFileSync(report, '<h1>what I found</h1>');
  });
  after(() => bridge.stop());

  /**
   * open.mjs as a session runs it. `setup` is handed the session key the script will resolve for
   * itself and may register it, attach a monitor, connect it - whatever rung is under test - and
   * may return a teardown. Nothing starts until it has finished.
   */
  const run = (args, { port = bridge.port, setup } = {}) => new Promise((resolve, reject) => {
    const child = spawn(claude, [launch, SCRIPT, ...args], {
      env: {
        ...process.env,
        LOCAL_ARTIFACT_PORT: String(port),
        TMPDIR: bridge.dir,
        // The ladder ends in openInBrowser, which would throw a real window at whoever is
        // running the suite; lib/common.mjs honours this and does nothing.
        LOCAL_ARTIFACT_NO_BROWSER: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let done;
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', reject);
    // `close` rather than `exit`: the output is what these tests read, and it is only all here
    // once the pipes have closed too.
    child.on('close', async (code) => {
      if (typeof done === 'function') await done();
      resolve({ code, out, err, key: `p${child.pid}` });
    });
    Promise.resolve(setup?.(`p${child.pid}`, child.pid)).then(
      (teardown) => { done = teardown; child.stdin.end('go\n'); },
      reject,
    );
  });

  /** The line a session relays: everything after it is the detail under it. */
  const first = (err) => err.split('\n')[0];

  test('with no argument at all, says how it is called', async () => {
    const { code, err } = await run([]);
    assert.equal(code, 2);
    assert.equal(first(err), 'open: usage: node scripts/open.mjs <file>');
  });

  test('refuses a web page, which needs no opening', async () => {
    const { code, err } = await run(['https://deployed.example/report']);
    assert.equal(code, 2);
    assert.match(first(err), /^open: web pages need no opening - open it in Chrome yourself/);
  });

  // Before the daemon is contacted at all, which is why this one runs against a port nothing is
  // listening on: the refusal is a fact about PDFs, not something a daemon has to be asked.
  test('refuses a PDF without contacting anything', async () => {
    const pdf = path.join(files, 'spec.PDF');
    fs.writeFileSync(pdf, 'never read');
    const port = await freePort();
    const { code, err } = await run([pdf], { port });
    assert.equal(code, 2);
    assert.equal(first(err), "open: PDF is not supported - Chrome's PDF viewer admits no anchor");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });

  test('refuses a path that is not a file, by its absolute name', async () => {
    const missing = path.join(files, 'never-written.html');
    const { code, err } = await run([missing]);
    assert.equal(code, 2);
    assert.equal(first(err), `open: not a file: ${missing}`);
  });

  /**
   * No daemon on the port. This is where the whole command could have quietly started one - and
   * a daemon it had to start is proof that /connect never ran, so the file would have opened into
   * a browser with nothing behind it.
   */
  test('with no daemon, names the command that fixes it and starts nothing', async () => {
    const port = await freePort();
    const { code, err } = await run([report], { port });
    assert.equal(code, 3);
    assert.equal(first(err), 'open: run /connect first - this session is not connected to the browser');
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });

  // Registered, but with nothing on its stream: the page would carry the button, the bridge would
  // take the comment, and no notification would ever be printed in this session.
  test('with no monitor attached, says so rather than open into silence', async () => {
    const { code, err } = await run([report], {
      setup: (key, pid) => register(bridge, key, pid),
    });
    assert.equal(code, 3);
    assert.equal(first(err), 'open: the monitor is not attached - run /connect in this session, then try again');
  });

  /**
   * Another session holds the browser. Opening does not take it - that is /connect's gesture - so
   * the comments on this file would arrive somewhere else entirely, and the refusal names where.
   */
  test('with another session connected, names the repo the comments would go to', async () => {
    const { code, err } = await run([report], {
      setup: async (key, pid) => {
        await register(bridge, key, pid);
        const monitor = await listen(bridge, key);
        await bridge.request('/register', {
          json: { key: `p${process.pid}`, pid: process.pid, cwd: '/tmp/elsewhere', repo: 'elsewhere' },
        });
        await connect(bridge, `p${process.pid}`);
        return () => monitor.close();
      },
    });
    assert.equal(code, 3);
    assert.equal(first(err), 'open: elsewhere is the session connected to the browser - run /connect '
      + 'here first, or its comments will go there');
  });

  /**
   * The last rung, and the only one this side cannot work out for itself: every precondition is
   * met, the daemon answers, and no extension has ever reached it - so the file would arrive in a
   * browser with no button on it and look exactly like one that worked.
   *
   * It runs before the success below, which is what seeds the sighting this daemon then keeps.
   */
  test('with no extension ever seen, it refuses and names the install', async () => {
    const { code, err } = await run([report], {
      setup: async (key, pid) => {
        await register(bridge, key, pid);
        const monitor = await listen(bridge, key);
        await connect(bridge, key);
        return () => monitor.close();
      },
    });
    assert.equal(code, 3);
    assert.match(first(err), /^open: the extension has never reached the bridge - install it: /);
    assert.match(first(err), /chrome:\/\/extensions -> Developer mode -> Load unpacked -> \S+\/extension$/);
  });

  test('connected, it opens the file and says where its comments go', async () => {
    // What a browser with the extension in it does on its own, on the first page it loads.
    await seenExtension(bridge);
    const { code, out, err, key } = await run([report], {
      setup: async (k, pid) => {
        await register(bridge, k, pid);
        const monitor = await listen(bridge, k);
        await connect(bridge, k);
        return () => monitor.close();
      },
    });
    assert.equal(err, '');
    assert.equal(code, 0);
    const [name, url, comments] = out.split('\n');
    assert.equal(name, 'open     report.html');
    assert.match(url, new RegExp(`^ {9}${bridge.origin}/p/[0-9a-f]{16}/$`));
    assert.match(comments, /^comments -> this session \(.+\)$/);
    /**
     * From the state on disk rather than from /health: the script's own ancestor was the session,
     * and asking /health now would prune the very session whose record is being checked. The
     * record is filed under the file it was opened from, which is what lets a comment from that
     * page name the path.
     */
    const state = JSON.parse(fs.readFileSync(path.join(bridge.stateDir, `previews-${bridge.port}.json`), 'utf8'));
    const record = state.previews.find(([, pv]) => pv.entry === report);
    assert.ok(record, JSON.stringify(state.previews));
    assert.equal(record[0], /\/p\/([0-9a-f]{16})\//.exec(url)[1]);
    assert.equal(record[1].kind, 'html');
    // The browser is this session's because /connect said so in the setup, not because a file
    // was opened - and it is still this session's afterwards.
    assert.equal(state.primaryKey, key);
  });
});
