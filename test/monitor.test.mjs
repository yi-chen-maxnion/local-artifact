import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comment, originId, startBridge } from './helpers.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const MONITOR = path.join(ROOT, 'scripts', 'monitor.mjs');

/**
 * How long the daemon still takes a comment for a session whose monitor has just gone. Long
 * enough here to cover killing one and starting the next, which is the whole scenario; the
 * helper's default is none, so it has to be named.
 */
const GRACE = 3000;

/**
 * The monitor's session key is the pid of the nearest `claude` process above it - derived, never
 * passed, because the daemon derives the same thing from `/connect` and the two have to agree.
 * A test therefore cannot spawn scripts/monitor.mjs on its own and be routed anything.
 *
 * So it is given a real ancestor rather than an env override of the one value both sides work out
 * for themselves: node under the name `claude`, running the supervisor below. It starts and kills
 * monitors on a line of stdin, and they inherit its stdout - so what this test reads is exactly
 * the bytes a session receives as a notification.
 */
const SUPERVISOR = `import { spawn } from 'node:child_process';
let child = null;
const stop = (signal) => { try { process.kill(child.pid, signal); } catch {} };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split('\\n')) {
    const [cmd, arg] = line.split(' ');
    if (cmd === 'start') child = spawn(process.execPath, [process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (cmd === 'kill') stop(arg || 'SIGKILL');
  }
});
process.on('SIGTERM', () => { if (child) stop('SIGKILL'); process.exit(0); });
`;

/** Poll until `ok()` or give up; `what` is what the failure says was never true. */
async function until(ok, what, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await ok();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('the monitor process', () => {
  let bridge;
  let claude; // the fake session process: the monitors' parent, and the session key
  let key;
  let previewId;
  let out = '';
  let err = '';

  before(async () => {
    bridge = await startBridge({ env: { LOCAL_ARTIFACT_LISTEN_GRACE_MS: String(GRACE) } });
    const dir = fs.mkdtempSync(path.join(bridge.dir, 'session-'));
    const named = path.join(dir, 'claude');
    // A symlink, not a copy: `ps` prints the name it was started under, which is all findClaudePid
    // reads. node itself resolves the link, so the monitors it spawns are plainly `node` and the
    // walk up from one of them stops here.
    fs.symlinkSync(process.execPath, named);
    const script = path.join(dir, 'session.mjs');
    fs.writeFileSync(script, SUPERVISOR);
    claude = spawn(named, [script, MONITOR], {
      // Everything the monitor needs to find this daemon rather than the real one: the port it
      // listens on, and the temp directory its token and state live under.
      env: { ...process.env, LOCAL_ARTIFACT_PORT: String(bridge.port), TMPDIR: bridge.dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    claude.stdout.on('data', (b) => { out += b; });
    claude.stderr.on('data', (b) => { err += b; });
    key = `p${claude.pid}`;
  });

  after(async () => {
    claude.stdin.write('kill\n');
    await new Promise((resolve) => { claude.once('exit', resolve); claude.kill(); });
    await bridge.stop();
  });

  /** How many monitors the daemon has on this session's stream. */
  const attached = async () => {
    const { sessions } = await (await bridge.request('/health')).json();
    return sessions.find((s) => s.key === key)?.clients ?? 0;
  };
  const start = async () => {
    claude.stdin.write('start\n');
    await until(attached, `a monitor on ${key}'s stream (stderr: ${err})`);
  };
  const kill = async (signal = 'SIGKILL') => {
    claude.stdin.write(`kill ${signal}\n`);
    await until(async () => await attached() === 0, 'the monitor to leave the stream');
  };
  const send = (text) => comment(bridge, previewId, {
    comment: text, page: { url: 'http://localhost:7600/a' },
  });
  const printed = (text) => until(() => out.includes(JSON.stringify(text)) && out, `"${text}" on stdout`);
  /** The header line of the nth notification. The repo is whatever this test run was started in. */
  const banner = (n) => new RegExp(`\\[ui-comment #${n} . [^\\]]+ . [a-f0-9]{6}\\]`);

  /**
   * The first comment of a session, sent while no monitor was running at all.
   *
   * Both halves of the hole in one: the monitor that went away had printed nothing, so its
   * position was the daemon's own zero, and the process that has to deliver the comment is not the
   * one that was told about it. Neither used to survive - a monitor starting from nothing asked
   * for nothing, and the comment sat in the replay buffer until the daemon forgot it. SIGKILL
   * rather than SIGTERM on purpose, so no cleanup handler runs and this is a crash as well as a stop.
   */
  test('delivers the first comment of a session to a monitor that replaced the one it was sent to', async () => {
    await start();
    // Only possible once the monitor has registered the session, which it does before it streams.
    previewId = await originId(bridge, 'http://localhost:7600');
    await kill();
    assert.equal((await send('sent while you were gone')).status, 200);
    await start();
    assert.match(await printed('sent while you were gone'), banner(1));
  });

  test('prints a comment sent while it is attached', async () => {
    assert.equal((await send('make it blue')).status, 200);
    assert.match(await printed('make it blue'), banner(2));
  });

  /**
   * The same again through the signal the host actually sends, which is the one that takes the
   * session's scratch directory with it. A watermark kept in there would be erased by exactly the
   * event it exists to survive, which is why it lives beside the daemon's own state instead.
   */
  test('survives the stop the host itself performs, which clears the scratch directory', async () => {
    await kill('SIGTERM');
    assert.equal(fs.existsSync(path.join(bridge.stateDir, key)), false);
    assert.equal((await send('and again')).status, 200);
    await start();
    await printed('and again');
    // Written where the monitor's own cleanup cannot reach, and stamped with the daemon whose
    // numbering it belongs to - a number from any other daemon means nothing.
    const w = JSON.parse(fs.readFileSync(path.join(bridge.stateDir, `watermark-${bridge.port}-${key}.json`), 'utf8'));
    const { instance } = await (await bridge.request('/health')).json();
    assert.equal(w.instance, instance);
    assert.equal(w.seq, 3);
  });

  test('says nothing on its own account - every line it writes is a comment', () => {
    assert.equal(err, '');
    assert.equal(out.match(/\[ui-comment/g).length, 3);
  });
});
