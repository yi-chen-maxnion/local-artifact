import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codeBuild, extensionHash, manifestVersion, pluginVersion, semverCmp, syncExtension,
} from '../lib/common.mjs';
import { versionsIn } from '../scripts/release.mjs';
import { EXTENSION_ID, ROOT, freePort, seenExtension, startBridge } from './helpers.mjs';

const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Five files say which version this is, and each is read by a different part of the update chain:
 * plugin.json by Claude Code, manifest.json by the daemon's folder sync, BUILD by the running
 * extension, package.json and its lock by npm. One of them left behind is an update that half
 * happens - the folder syncs and the extension never reloads, or the reverse - so they are held
 * equal on every commit, not only by the release script that moves them.
 */
describe('the version sources agree', () => {
  test('plugin.json, manifest.json, BUILD, package.json and package-lock.json', () => {
    const found = versionsIn(ROOT);
    const want = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json')).version;
    assert.match(want, /^\d+\.\d+\.\d+$/);
    // Every source is present: a BUILD line that went missing would read as null, not as agreement.
    assert.deepEqual(Object.keys(found).sort(), [
      '.claude-plugin/plugin.json', 'extension/background.js', 'extension/manifest.json',
      'package-lock.json', 'package-lock.json packages[""]', 'package.json',
    ]);
    for (const [file, version] of Object.entries(found)) assert.equal(version, want, file);
    assert.equal(pluginVersion(ROOT), want);
  });
});

describe('semverCmp', () => {
  test('orders by major, then minor, then patch, numerically', () => {
    assert.equal(semverCmp('0.2.0', '0.1.9'), 1);
    assert.equal(semverCmp('0.10.0', '0.9.0'), 1); // not as strings
    assert.equal(semverCmp('1.0.0', '0.99.99'), 1);
    assert.equal(semverCmp('0.1.0', '0.1.1'), -1);
    assert.equal(semverCmp('2.3.4', '2.3.4'), 0);
  });

  // A daemon or an extension from before versions sends none; it is older than every release.
  test('missing or malformed is 0.0.0', () => {
    for (const bad of [undefined, null, '', 'x', '1.2', '1.2.3-beta', 'v1.2.3', '01.2.3', 7]) {
      assert.equal(semverCmp(bad, '0.0.0'), 0, String(bad));
      assert.equal(semverCmp(bad, '0.0.1'), -1, String(bad));
      assert.equal(semverCmp('0.0.1', bad), 1, String(bad));
    }
  });

  test('pluginVersion is 0.0.0 for a copy with no plugin.json, or none in it', () => {
    const root = tmpdir('cc-plugin-');
    assert.equal(pluginVersion(root), '0.0.0');
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
    assert.equal(pluginVersion(root), '0.0.0');
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{"version":"3.4.5"}');
    assert.equal(pluginVersion(root), '3.4.5');
  });
});

/** A plugin checkout of its own: an `extension/` at `version`, with `body` in one of its files. */
function plugin(version, body = 'one', { git = false } = {}) {
  const root = tmpdir('cc-root-');
  const ext = path.join(root, 'extension');
  fs.mkdirSync(path.join(ext, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, version }));
  fs.writeFileSync(path.join(ext, 'background.js'), `const BUILD = '${version}'; // ${body}`);
  fs.writeFileSync(path.join(ext, 'icons', 'a.txt'), body);
  if (git) fs.mkdirSync(path.join(root, '.git'));
  return root;
}

/** An installed folder beside nothing else, as it would be under ~/.config/local-artifact. */
function installed(version, body = 'installed') {
  const dir = path.join(tmpdir('cc-config-'), 'extension');
  fs.cpSync(path.join(plugin(version, body), 'extension'), dir, { recursive: true });
  return dir;
}

const siblings = (dir) => fs.readdirSync(path.dirname(dir)).filter((n) => n !== path.basename(dir));
const same = (a, b) => extensionHash(a) === extensionHash(b);
const NO_DEV = { env: {} };

describe('extensionHash', () => {
  test('is the content, not the mtimes, and ignores dotfiles', () => {
    const root = plugin('0.1.0');
    const ext = path.join(root, 'extension');
    const before = extensionHash(ext);
    // What a copy does to every file: a new mtime, the same bytes.
    const later = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(path.join(ext, 'background.js'), later, later);
    fs.writeFileSync(path.join(ext, '.DS_Store'), 'finder');
    assert.equal(extensionHash(ext), before);
    fs.writeFileSync(path.join(ext, 'icons', 'a.txt'), 'two');
    assert.notEqual(extensionHash(ext), before);
  });

  test('moving bytes from one file to another is a change', () => {
    const a = plugin('0.1.0');
    const b = plugin('0.1.0');
    fs.writeFileSync(path.join(a, 'extension', 'x'), 'ab');
    fs.writeFileSync(path.join(a, 'extension', 'y'), '');
    fs.writeFileSync(path.join(b, 'extension', 'x'), 'a');
    fs.writeFileSync(path.join(b, 'extension', 'y'), 'b');
    assert.notEqual(extensionHash(path.join(a, 'extension')), extensionHash(path.join(b, 'extension')));
  });
});

/**
 * The folder is synced when a daemon starts, and /connect replaces the daemon when this changes -
 * so an edit to extension/ in a checkout has to change it, or the edit would sit on disk until the
 * daemon happened to restart for some other reason.
 */
describe('codeBuild', () => {
  test('changes with the extension as well as the daemon code', () => {
    const root = plugin('0.1.0');
    for (const dir of ['bridge', 'lib']) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'x.mjs'), '');
    }
    const before = codeBuild(root);
    const later = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(path.join(root, 'extension', 'background.js'), later, later);
    assert.notEqual(codeBuild(root), before);
    const now = codeBuild(root);
    fs.utimesSync(path.join(root, 'lib', 'x.mjs'), later, new Date(later.getTime() + 1000));
    assert.notEqual(codeBuild(root), now);
  });
});

describe('syncExtension', () => {
  test('a folder that is not there is created', () => {
    const root = plugin('0.2.0');
    const dir = path.join(tmpdir('cc-config-'), 'nested', 'extension');
    assert.deepEqual(syncExtension(root, dir, NO_DEV), {
      synced: true, from: null, to: '0.2.0', reason: 'nothing loadable was there',
    });
    assert.ok(same(dir, path.join(root, 'extension')));
    assert.deepEqual(siblings(dir), []);
  });

  test('an older folder is replaced whole', () => {
    const root = plugin('0.2.0', 'new');
    const dir = installed('0.1.0');
    fs.writeFileSync(path.join(dir, 'gone.js'), 'a file the new version no longer has');
    assert.deepEqual(syncExtension(root, dir, NO_DEV), { synced: true, from: '0.1.0', to: '0.2.0', reason: 'an update' });
    assert.ok(same(dir, path.join(root, 'extension')));
    assert.equal(fs.existsSync(path.join(dir, 'gone.js')), false);
    assert.deepEqual(siblings(dir), []);
  });

  /**
   * A session still running an older copy of the plugin - its daemon started first, say - must
   * never take the extension back from under a newer one: the browser would reload into old code.
   */
  test('a newer folder is never touched, not even in a development checkout', () => {
    const dir = installed('0.3.0');
    const was = extensionHash(dir);
    for (const root of [plugin('0.2.0'), plugin('0.2.0', 'x', { git: true })]) {
      assert.deepEqual(syncExtension(root, dir, { env: { LOCAL_ARTIFACT_DEV: '1' } }), {
        synced: false, from: '0.3.0', to: '0.2.0', reason: 'the folder holds a newer version',
      });
      assert.equal(extensionHash(dir), was);
    }
  });

  test('the same version is left alone in an installed copy, whatever the contents', () => {
    const dir = installed('0.2.0', 'theirs');
    const was = extensionHash(dir);
    assert.deepEqual(syncExtension(plugin('0.2.0', 'ours'), dir, NO_DEV), {
      synced: false, from: '0.2.0', to: '0.2.0', reason: 'up to date',
    });
    assert.equal(extensionHash(dir), was);
  });

  /**
   * How an edit to extension/ reaches the browser while the version stays put: the checkout this
   * repo is developed in has a .git, and nothing a marketplace installs does. The environment
   * variable is the same switch for a checkout without one.
   */
  test('the same version is synced from a development checkout when the contents differ', () => {
    const viaGit = plugin('0.2.0', 'edited', { git: true });
    const dir = installed('0.2.0', 'before');
    assert.deepEqual(syncExtension(viaGit, dir, NO_DEV), {
      synced: true, from: '0.2.0', to: '0.2.0', reason: 'a development edit',
    });
    assert.ok(same(dir, path.join(viaGit, 'extension')));
    // Nothing changed since: nothing to do, and nothing copied.
    const stamp = fs.statSync(path.join(dir, 'background.js')).mtimeMs;
    assert.deepEqual(syncExtension(viaGit, dir, NO_DEV), {
      synced: false, from: '0.2.0', to: '0.2.0', reason: 'up to date',
    });
    assert.equal(fs.statSync(path.join(dir, 'background.js')).mtimeMs, stamp);

    const viaEnv = plugin('0.2.0', 'edited again');
    assert.equal(syncExtension(viaEnv, dir, { env: { LOCAL_ARTIFACT_DEV: '1' } }).synced, true);
    assert.ok(same(dir, path.join(viaEnv, 'extension')));
    assert.equal(syncExtension(plugin('0.2.0', 'x'), dir, { env: { LOCAL_ARTIFACT_DEV: '0' } }).synced, false);
  });

  test('a plugin with no extension copies nothing', () => {
    const root = tmpdir('cc-root-');
    const dir = installed('0.1.0');
    assert.equal(syncExtension(root, dir, NO_DEV).synced, false);
    assert.equal(manifestVersion(dir), '0.1.0');
  });

  /** A pid that was alive a moment ago and is not now. */
  const deadPid = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid));
  });

  test('what an interrupted swap left beside the folder is cleaned up, unless its owner is alive', async () => {
    const dir = installed('0.2.0');
    const dead = await deadPid();
    const leftovers = [`extension.tmp-${dead}-abc123`, `extension.old-${dead}-abc123`, `extension.tmp-${process.pid}-zz9`];
    for (const name of leftovers) fs.cpSync(dir, path.join(path.dirname(dir), name), { recursive: true });
    // Someone else's swap in progress, and a name that is not ours at all.
    const live = `extension.tmp-${process.ppid}-live01`;
    fs.mkdirSync(path.join(path.dirname(dir), live));
    fs.mkdirSync(path.join(path.dirname(dir), 'extension.backup'));
    syncExtension(plugin('0.2.0'), dir, NO_DEV);
    assert.deepEqual(siblings(dir).sort(), ['extension.backup', live]);
    assert.equal(manifestVersion(dir), '0.2.0');
  });

  /**
   * A crash between the two renames: the folder moved aside, the new one never put in. Chrome
   * has nothing to load until the next sync, which puts the old one back before deciding anything
   * - here there is nothing newer to replace it with, so what comes back is exactly what was there.
   */
  test('a folder lost between the two renames is restored from the old one', async () => {
    const dir = installed('0.3.0', 'what chrome had');
    const was = extensionHash(dir);
    const old = path.join(path.dirname(dir), `extension.old-${await deadPid()}-crash1`);
    fs.renameSync(dir, old);
    assert.deepEqual(syncExtension(plugin('0.2.0'), dir, NO_DEV), {
      synced: false, from: '0.3.0', to: '0.2.0', reason: 'the folder holds a newer version',
    });
    assert.equal(extensionHash(dir), was);
    assert.deepEqual(siblings(dir), []);
  });

  /**
   * The second rename is the one that can leave Chrome with nothing: the old folder has already
   * moved aside. When it fails the old one goes back, and the next call tries again.
   */
  test('a failed second rename leaves the old folder in place, loadable', () => {
    const root = plugin('0.2.0');
    const dir = installed('0.1.0', 'what chrome had');
    const was = extensionHash(dir);
    const rename = (from, to) => {
      if (path.basename(from).startsWith('extension.tmp-')) {
        throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      }
      return fs.renameSync(from, to);
    };
    const r = syncExtension(root, dir, { ...NO_DEV, rename });
    assert.equal(r.synced, false);
    assert.equal(r.error, 'EIO: injected');
    assert.equal(manifestVersion(dir), '0.1.0');
    assert.equal(extensionHash(dir), was);
    assert.deepEqual(siblings(dir), []);
    // And the next sync, with nothing in its way, does the update.
    assert.equal(syncExtension(root, dir, NO_DEV).synced, true);
    assert.equal(manifestVersion(dir), '0.2.0');
  });

  /**
   * One daemon is the only writer, but a daemon being replaced and its successor can meet here,
   * and so can two test daemons on one config directory. Two processes race the same swap from
   * two different sources; whatever the interleaving, the folder is whole - exactly one of the
   * two - and nothing is left beside it. Several rounds, since one race proves little.
   */
  test('two processes syncing at once end with one whole folder', async () => {
    const lib = path.join(ROOT, 'lib', 'common.mjs');
    const racer = (root, dir, at) => new Promise((resolve, reject) => {
      const code = `
        import { syncExtension } from ${JSON.stringify(lib)};
        while (Date.now() < ${at}) {}
        const r = syncExtension(${JSON.stringify(root)}, ${JSON.stringify(dir)}, { env: { LOCAL_ARTIFACT_DEV: '1' } });
        process.stdout.write(JSON.stringify(r));
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (b) => { out += b; });
      child.on('error', reject);
      child.on('exit', (status) => (status === 0 ? resolve(JSON.parse(out)) : reject(new Error(`racer exited ${status}`))));
    });
    for (let round = 0; round < 6; round++) {
      const a = plugin('0.2.0', `a${round}`.repeat(2000));
      const b = plugin('0.2.0', `b${round}`.repeat(2000));
      // Every other round over an existing older folder, so both renames are raced too.
      const dir = round % 2 ? installed('0.1.0') : path.join(tmpdir('cc-config-'), 'extension');
      const at = Date.now() + 400;
      const results = await Promise.all([racer(a, dir, at), racer(b, dir, at)]);
      assert.ok(results.some((r) => r.synced), JSON.stringify(results));
      const got = extensionHash(dir);
      const ours = [extensionHash(path.join(a, 'extension')), extensionHash(path.join(b, 'extension'))];
      assert.ok(ours.includes(got), `round ${round}: the folder is neither copy - ${JSON.stringify(results)}`);
      assert.deepEqual(siblings(dir), [], `round ${round}`);
    }
  });
});

/**
 * ensureDaemon against a bridge that answers /health as told. A process of its own, so that
 * killing it - what ensureDaemon does to a daemon it replaces - is something the test can see,
 * and so that the port comes free for the real daemon that replaces it.
 */
function fakeBridge(port, health) {
  const code = `
    const http = require('node:http');
    http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, ...${JSON.stringify(health)} }));
    }).listen(${port}, '127.0.0.1', () => process.stdout.write('up'));
  `;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('ensureDaemon and a daemon already on the port', () => {
  let dir;
  const env = (port) => ({
    ...process.env,
    LOCAL_ARTIFACT_PORT: String(port),
    TMPDIR: dir,
    LOCAL_ARTIFACT_CONFIG_DIR: path.join(dir, 'config'),
  });
  before(() => { dir = tmpdir('cc-ensure-'); });

  /** ensureDaemon in a process of its own, which is what reads the port from the environment. */
  const ensure = (port) => new Promise((resolve, reject) => {
    const code = `
      import { ensureDaemon } from ${JSON.stringify(path.join(ROOT, 'lib', 'common.mjs'))};
      process.stdout.write(JSON.stringify(await ensureDaemon()));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: env(port), stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.on('error', reject);
    child.on('exit', (status) => (status === 0 ? resolve(JSON.parse(out)) : reject(new Error(`ensureDaemon exited ${status}`))));
  });

  /** The daemon that is on the port now, by its token-gated /health. */
  const current = async (port) => {
    const token = fs.readFileSync(path.join(dir, 'claude-ui-comments', `token-${port}`), 'utf8').trim();
    return (await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-cc-token': token } })).json();
  };

  test('a daemon from a newer copy of the plugin is kept, and the caller is told why', async () => {
    const port = await freePort();
    const fake = await fakeBridge(port, { version: '99.0.0', build: 'elsewhere', root: '/some/newer/copy' });
    try {
      const { note } = await ensure(port);
      assert.equal(note, 'bridge 99.0.0 is running from a newer copy of the plugin - restart this session to update it');
      assert.ok(alive(fake.pid), 'the newer daemon was killed');
    } finally {
      fake.kill('SIGKILL');
    }
  });

  for (const [what, health] of [
    ['an older version', { version: '0.0.1' }],
    ['no version at all', {}],
    ['a malformed version', { version: 'banana' }],
  ]) {
    test(`a daemon with ${what} is replaced by one running this code`, async () => {
      const port = await freePort();
      const fake = await fakeBridge(port, { ...health, build: 'old', root: '/some/older/copy' });
      const gone = new Promise((resolve) => fake.once('exit', resolve));
      let h;
      try {
        assert.deepEqual(await ensure(port), { note: null });
        await gone;
        h = await current(port);
        assert.equal(h.root, ROOT);
        assert.equal(h.version, pluginVersion(ROOT));
      } finally {
        fake.kill('SIGKILL');
        if (h?.pid) process.kill(h.pid);
      }
    });
  }

  // The same version from another copy is the case that existed before versions: replaced as then.
  test('a daemon with the same version from another copy is replaced as before', async () => {
    const port = await freePort();
    const fake = await fakeBridge(port, { version: pluginVersion(ROOT), build: 'old', root: '/another/copy' });
    const gone = new Promise((resolve) => fake.once('exit', resolve));
    let h;
    try {
      assert.deepEqual(await ensure(port), { note: null });
      await gone;
      h = await current(port);
      assert.equal(h.root, ROOT);
    } finally {
      fake.kill('SIGKILL');
      if (h?.pid) process.kill(h.pid);
    }
  });
});

/**
 * What /connect prints when it meets a newer daemon: the note, above the monitor line, and a
 * setup that otherwise goes on as usual against the daemon that is there. The fake answers every
 * route the script calls, and reports the session's monitor as attached once it has registered.
 */
describe('scripts/connect.mjs and a newer daemon', () => {
  test('keeps it and says the session is the old thing', async () => {
    const port = await freePort();
    const dir = tmpdir('cc-connect-newer-');
    const code = `
      const http = require('node:http');
      let key = null;
      http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url === '/register') key = JSON.parse(body).key;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true, pid: process.pid, version: '99.0.0', build: 'b', root: '/newer', primary: key,
            previous: null,
            sessions: key ? [{ key, repo: 'r', clients: 1 }] : [],
            extension: { seenAt: Date.now(), id: '${EXTENSION_ID}', version: '99.0.0' },
            extensions: [{ id: '${EXTENSION_ID}', version: '99.0.0', seenAt: Date.now() }],
            extDir: { path: '/x/extension', version: '99.0.0' },
          }));
        });
      }).listen(${port}, '127.0.0.1', () => process.stdout.write('up'));
    `;
    const fake = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => fake.stdout.once('data', resolve));
    try {
      const exe = path.join(dir, 'claude');
      fs.symlinkSync(process.execPath, exe);
      const { status, out } = await new Promise((resolve) => {
        const child = spawn(exe, [path.join(ROOT, 'scripts', 'connect.mjs')], {
          env: { ...process.env, LOCAL_ARTIFACT_PORT: String(port), TMPDIR: dir, LOCAL_ARTIFACT_CONFIG_DIR: dir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let o = '';
        child.stdout.on('data', (b) => { o += b; });
        child.on('exit', (s) => resolve({ status: s, out: o }));
      });
      assert.equal(status, 0, out);
      assert.match(out, /\n {2}bridge 99\.0\.0 is running from a newer copy of the plugin - restart this session to update it\n {2}monitor listening\n$/);
      assert.ok(alive(fake.pid));
    } finally {
      fake.kill('SIGKILL');
    }
  });
});

/**
 * The daemon's side of updates: its version in /health, the folder it syncs at start, the
 * extension versions it has heard, and the header that tells the extension what the folder holds.
 */
describe('/health and x-cc-ext-latest', () => {
  let bridge;
  const EXT = readJson(path.join(ROOT, 'extension', 'manifest.json')).version;
  const health = async (b = bridge) => (await b.request('/health')).json();

  before(async () => { bridge = await startBridge(); });
  after(() => bridge.stop());

  test('reports its version and protocol, and the folder it synced at start', async () => {
    const h = await health();
    assert.equal(h.version, pluginVersion(ROOT));
    assert.equal(h.protocol, 1);
    assert.deepEqual(h.extDir, {
      path: path.join(bridge.configDir, 'extension'), version: EXT,
      sync: { synced: true, from: null, to: EXT, reason: 'nothing loadable was there' },
    });
    assert.ok(same(h.extDir.path, path.join(ROOT, 'extension')));
    const bare = await (await bridge.request('/health', { token: null })).json();
    assert.equal(bare.version, pluginVersion(ROOT));
  });

  test('every response carries the folder version: JSON, an error, a page, the event stream', async () => {
    for (const route of ['/health', '/no-such-route', '/p/nothing/']) {
      const res = await bridge.request(route);
      assert.equal(res.headers.get('x-cc-ext-latest'), EXT, route);
    }
    assert.equal((await bridge.request('/health', { token: null })).headers.get('x-cc-ext-latest'), EXT);
    const ctl = new AbortController();
    const events = await fetch(`${bridge.origin}/events?session=p${process.pid}`, {
      headers: { 'x-cc-token': bridge.token }, signal: ctl.signal,
    });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    assert.equal(events.headers.get('x-cc-ext-latest'), EXT);
    ctl.abort();
  });

  test('records the version each extension says it runs, and every id heard lately', async () => {
    let h = await health();
    assert.equal(h.extension, null);
    assert.equal(h.extensionVersion, null);
    assert.deepEqual(h.extensions, []);

    await seenExtension(bridge, EXTENSION_ID, { version: '0.1.7' });
    h = await health();
    assert.equal(h.extensionVersion, '0.1.7');
    assert.equal(h.extension.version, '0.1.7');
    assert.deepEqual(h.extensions.map((e) => [e.id, e.version]), [[EXTENSION_ID, '0.1.7']]);

    // A second copy, too old to say what it runs: both are listed, and the last one to speak is
    // the one `extension` describes.
    const zip = 'ponmlkjihgfedcbaponmlkjihgfedcba';
    await seenExtension(bridge, zip, { version: null });
    h = await health();
    assert.equal(h.extension.id, zip);
    assert.equal(h.extensionVersion, null);
    assert.deepEqual(h.extensions.map((e) => [e.id, e.version]).sort(), [[EXTENSION_ID, '0.1.7'], [zip, null]]);

    // A version that is not one is nothing, not a string to compare.
    await seenExtension(bridge, EXTENSION_ID, { version: '0.1.7; drop' });
    assert.equal((await health()).extensionVersion, null);
  });

  test('the sightings and their versions survive a restart', async () => {
    await seenExtension(bridge, EXTENSION_ID, { version: '0.1.8' });
    const was = await health();
    await bridge.stop();
    bridge = await startBridge({ tmp: bridge.dir, port: bridge.port });
    const now = await health();
    assert.deepEqual(now.extension, was.extension);
    assert.equal(now.extensionVersion, '0.1.8');
    assert.deepEqual(now.extensions, was.extensions);
    // The folder was already this version with these contents: the restart copies nothing.
    assert.equal(now.extDir.sync.synced, false);
  });

  /**
   * The downgrade the daemon must never do: a folder a newer copy of the plugin already filled is
   * left as it is, and the header says what is there, so the extension is not told to reload
   * into anything older.
   */
  test('a folder holding a newer version is kept, and the header says so', async () => {
    const dir = tmpdir('cc-bridge-newer-');
    const ext = path.join(dir, 'config', 'extension');
    fs.cpSync(path.join(plugin('99.1.0'), 'extension'), ext, { recursive: true });
    const newer = await startBridge({ tmp: dir });
    try {
      const h = await health(newer);
      assert.equal(h.extDir.version, '99.1.0');
      assert.equal(h.extDir.sync.synced, false);
      assert.equal((await newer.request('/health')).headers.get('x-cc-ext-latest'), '99.1.0');
      assert.equal(manifestVersion(ext), '99.1.0');
    } finally {
      await newer.stop();
    }
  });

  test('an older folder is brought up to this version at start', async () => {
    const dir = tmpdir('cc-bridge-older-');
    const ext = path.join(dir, 'config', 'extension');
    fs.cpSync(path.join(plugin('0.0.1'), 'extension'), ext, { recursive: true });
    const b = await startBridge({ tmp: dir });
    try {
      const h = await health(b);
      assert.deepEqual(h.extDir.sync, { synced: true, from: '0.0.1', to: EXT, reason: 'an update' });
      assert.equal((await b.request('/health')).headers.get('x-cc-ext-latest'), EXT);
    } finally {
      await b.stop();
    }
  });

  /**
   * Nothing readable in the folder - here because it cannot be written at all - is no header:
   * "nothing to move to", where a made-up version would send the extension reloading into nothing.
   */
  test('no readable folder, no header - and /health says why', async () => {
    const dir = tmpdir('cc-bridge-ro-');
    const config = path.join(dir, 'config');
    fs.mkdirSync(config, { recursive: true });
    fs.chmodSync(config, 0o500);
    let b;
    try {
      b = await startBridge({ tmp: dir });
      const res = await b.request('/health');
      assert.equal(res.headers.get('x-cc-ext-latest'), null);
      const h = await res.json();
      assert.equal(h.extDir.version, null);
      assert.equal(h.extDir.sync.synced, false);
      assert.match(h.extDir.error, /EACCES|permission/i);
    } finally {
      await b?.stop();
      fs.chmodSync(config, 0o700);
    }
  });
});
