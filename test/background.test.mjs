/**
 * The service worker updating itself, run against the real extension/background.js.
 *
 * The extension is loaded unpacked once, from a folder the bridge daemon rewrites with each new
 * version, and the worker reloads itself onto what it finds there. A reload is the one thing the
 * extension does that can lose a user's work or kill the extension outright - a comment cut off on
 * its way, a panel full of text left with nothing behind it, a folder loaded half-written, or
 * Chrome terminating an extension that reloads in a loop - and none of those shows up by clicking
 * around. So each guard is here, each one against the worst thing it stands between.
 *
 * See test/background-harness.mjs for the fake Chrome, the folder and the clock.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock, RUNNING, bump, folder, startWorker } from './background-harness.mjs';

const NEXT = bump(RUNNING);
const SETTLE = 5000; // the worker's wait between reading the folder twice

/** A tab with a live overlay that answers `cc-busy?` with whatever `busy()` says now. */
const tab = (id, url, busy = () => false) => ({
  id, url, overlay: (msg) => (msg?.type === 'cc-busy?' ? { busy: busy() } : undefined),
});

describe('which versions it reloads for', () => {
  test('the same version in the folder: no reload', async () => {
    const w = await startWorker({ disk: folder(RUNNING) });
    await w.advance(60_000);
    assert.deepEqual(w.reloads, []);
    assert.ok(w.logs.some((l) => l.includes('checked')), w.logs.join('\n'));
  });

  test('an older version in the folder: no reload', async () => {
    const w = await startWorker({ disk: folder('0.0.1') });
    await w.advance(60_000);
    assert.deepEqual(w.reloads, []);
  });

  test('a newer version: one reload, after the folder has been read twice', async () => {
    const w = await startWorker({ disk: folder(NEXT) });
    await w.advance(SETTLE - 1000);
    assert.deepEqual(w.reloads, [], 'it reloaded before reading the folder a second time');
    await w.advance(2000);
    assert.equal(w.reloads.length, 1);
    assert.deepEqual(w.store.selfUpdate, { target: NEXT, attempts: 1, lastAt: w.reloads[0] });
    assert.ok(w.logs.some((l) => l.includes(`reloading: ${RUNNING} -> ${NEXT}`)), w.logs.join('\n'));
  });

  test('what it is running is its own BUILD, not what getManifest() says', async () => {
    // The fake getManifest() answers with the folder, as Chrome can after a restart. A worker that
    // compared against it would find itself current and never move.
    const w = await startWorker({ disk: folder(NEXT) });
    assert.equal(w.chrome.runtime.getManifest().version, NEXT);
    await w.advance(SETTLE + 1000);
    assert.equal(w.reloads.length, 1);
  });
});

describe('a folder half-way through a sync is left alone', () => {
  test('manifest new, background.js still old: no reload, then one once both agree', async () => {
    const w = await startWorker({ disk: folder(NEXT, RUNNING), latest: NEXT });
    await w.advance(SETTLE + 1000);
    assert.deepEqual(w.reloads, [], 'it reloaded onto a half-written folder');
    assert.ok(w.logs.some((l) => l.includes('mid-sync')), w.logs.join('\n'));

    // The sync finishes; the next bridge response is the next trigger.
    Object.assign(w.disk, folder(NEXT));
    await w.ask('status');
    await w.advance(SETTLE + 1000);
    assert.equal(w.reloads.length, 1);
  });
});

describe('it waits for work in progress', () => {
  test('a tab with an unsent comment defers it, says so on the icon, and it reloads once sent', async () => {
    let writing = true;
    const w = await startWorker({
      disk: folder(NEXT),
      tabs: [
        tab(1, 'http://localhost:5173/', () => writing),
        // No overlay at all, and a page nothing is injected into: neither is waited for.
        { id: 2, url: 'https://example.com/' },
        { id: 3, url: 'chrome://extensions/' },
      ],
    });
    await w.advance(SETTLE + 2000);
    assert.deepEqual(w.reloads, [], 'it reloaded under a comment being written');
    assert.equal(w.lastBadge(), 'UP');
    assert.ok(w.badges.some((b) => b.tabId === 1 && b.text === 'UP'), 'the tab itself does not say it');
    assert.ok(w.titles.some((t) => t.tabId === 1 && /finish your comment/.test(t.title)));
    // Spread, because it was built in the worker's realm, whose Object is not this file's.
    assert.deepEqual({ ...await w.ask('version') }, { build: RUNNING, ready: NEXT });
    assert.ok(w.logs.some((l) => l.includes('deferred: a comment is being written')), w.logs.join('\n'));
    assert.ok(!w.messages.some((m) => m.tabId === 3), 'it asked a chrome:// page');

    writing = false;
    await w.advance(60_000);
    assert.equal(w.reloads.length, 1);
  });

  test('a tab that never answers is not waited for', async () => {
    const w = await startWorker({
      disk: folder(NEXT),
      tabs: [{ id: 1, url: 'http://localhost:5173/', overlay: () => new Promise(() => {}) }],
    });
    await w.advance(SETTLE + 3000);
    assert.equal(w.reloads.length, 1);
  });

  test('a request of its own in flight defers it until that request is back', async () => {
    let release;
    const w = await startWorker({
      disk: folder(NEXT),
      bridge: (route) => (route === '/comment'
        ? new Promise((r) => { release = () => r({ status: 200, body: { n: 1 } }); })
        : { status: 200, body: {} }),
    });
    const sent = w.ask('comment', { previewId: 'p1', comment: 'hi' });
    await w.advance(SETTLE + 1000);
    assert.deepEqual(w.reloads, [], 'it reloaded with a comment on its way to the bridge');
    assert.ok(w.logs.some((l) => l.includes('in flight')), w.logs.join('\n'));

    release();
    assert.equal((await sent).n, 1);
    await w.advance(SETTLE + 1000);
    assert.equal(w.reloads.length, 1);
  });
});

describe('the loop guard: two reloads per version, ten seconds apart', () => {
  /**
   * A reload that does not bring the new version up - Chrome loading something other than what
   * the folder says - starts a worker with the same old BUILD, which finds the same newer folder.
   * Played here as a new worker on the same storage and clock each time.
   */
  test('a second reload waits ten seconds, and there is no third', async () => {
    const clock = new Clock();
    const store = {};
    const disk = folder(NEXT);

    const first = await startWorker({ disk, clock, store });
    await first.advance(SETTLE + 500);
    assert.equal(first.reloads.length, 1);
    const firstAt = first.reloads[0];

    const second = await startWorker({ disk, clock, store });
    await second.advance(SETTLE + 500);
    assert.deepEqual(second.reloads, [], 'the second reload came under ten seconds after the first');
    assert.ok(second.logs.some((l) => l.includes('under 10 s')), second.logs.join('\n'));
    await second.advance(30_000);
    assert.equal(second.reloads.length, 1);
    assert.ok(second.reloads[0] - firstAt >= 10_000);
    assert.equal(store.selfUpdate.attempts, 2);

    const third = await startWorker({ disk, clock, store, latest: NEXT });
    await third.advance(120_000);
    await third.ask('status'); // a bridge response saying the folder is ahead asks again
    await third.advance(120_000);
    assert.deepEqual(third.reloads, [], 'a third reload for the same version');
    assert.ok(third.logs.some((l) => l.includes('gave up')), third.logs.join('\n'));
  });

  test('the cap is per version: a later one gets its own two', async () => {
    const store = { selfUpdate: { target: NEXT, attempts: 2, lastAt: 0 } };
    const w = await startWorker({ disk: folder(bump(NEXT)), store });
    await w.advance(SETTLE + 1000);
    assert.equal(w.reloads.length, 1);
    assert.deepEqual(store.selfUpdate.target, bump(NEXT));
    assert.equal(store.selfUpdate.attempts, 1);
  });
});

describe('the bridge says when the folder has moved on', () => {
  test('x-cc-ext-latest higher than BUILD starts a check; equal to it does not', async () => {
    const w = await startWorker({ disk: folder(RUNNING), latest: RUNNING });
    await w.advance(60_000);
    // The folder moves on without the bridge saying so yet.
    Object.assign(w.disk, folder(NEXT));
    const reads = w.folderReads.length;
    await w.ask('status');
    await w.advance(60_000);
    assert.equal(w.folderReads.length, reads, 'an equal header started a check');
    assert.deepEqual(w.reloads, []);

    w.latest = NEXT;
    await w.ask('status');
    await w.advance(SETTLE + 1000);
    assert.equal(w.reloads.length, 1);
  });

  test('every request to the bridge says which version is asking', async () => {
    const w = await startWorker({ tabs: [tab(1, 'http://localhost:5173/')] });
    await w.ask('status');
    w.chrome.tabs.onUpdated.fire(1, { status: 'complete' }, { id: 1, url: 'http://localhost:5173/' });
    await w.advance(100);
    const routes = w.requests.map((r) => r.route);
    assert.ok(routes.includes('/status') && routes.some((r) => r.startsWith('/resolve')), routes.join(' '));
    for (const r of w.requests) assert.equal(r.headers['x-cc-ext-version'], RUNNING, r.route);
  });
});

describe('after a reload, open pages get an overlay again', () => {
  const tabs = [
    tab(1, 'http://localhost:5173/app'),
    tab(2, 'https://example.com/x'),
    { id: 3, url: 'chrome://extensions/' },
    { id: 4, url: 'file:///tmp/a.html' },
  ];
  const overlaid = (w) => w.injections.filter((i) => i.files?.includes('overlay.js')).map((i) => i.target.tabId);

  test('onInstalled with reason update injects into every http(s) tab, with the build', async () => {
    const w = await startWorker({ tabs });
    w.chrome.runtime.onInstalled.fire({ reason: 'update', previousVersion: '0.0.9' });
    await w.advance(100);
    assert.deepEqual(overlaid(w).sort(), [1, 2]);
    const configs = w.injections.filter((i) => i.args).map((i) => i.args[0]);
    assert.ok(configs.length >= 2 && configs.every((c) => c.build === RUNNING), JSON.stringify(configs));
    assert.ok(w.logs.some((l) => l.includes(`now running ${RUNNING}`)), w.logs.join('\n'));
  });

  test('and on install; but not when Chrome itself updated', async () => {
    const w = await startWorker({ tabs });
    w.chrome.runtime.onInstalled.fire({ reason: 'chrome_update' });
    await w.advance(100);
    assert.deepEqual(overlaid(w), []);
    w.chrome.runtime.onInstalled.fire({ reason: 'install' });
    await w.advance(100);
    assert.deepEqual(overlaid(w).sort(), [1, 2]);
  });
});
