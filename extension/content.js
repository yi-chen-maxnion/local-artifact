/**
 * The relay, for the pages the bridge serves itself - and only those.
 *
 * Everywhere else the service worker injects the overlay into this extension's isolated world,
 * where it talks to the worker directly and the page's own scripts cannot reach it. A page the
 * bridge serves loads the overlay with a `<script>` tag instead, so it runs in the page world,
 * cannot call `chrome.runtime`, and needs this channel for what only the extension can do for
 * it: say it is installed, take a screenshot, and pass on the toolbar menu's settings. Its
 * comments go straight to the bridge, which is its own origin.
 *
 * A relay on any other page would hand every script on that page a line to the worker.
 */
(() => {
  // The bridge's exact origin, pinned: no other server on 127.0.0.1 gets a line to the worker. The
  // other copies are background.js's BRIDGE and the README bookmarklet - test/extension.test.mjs.
  if (location.origin !== 'http://127.0.0.1:4517' || window.__ccRelay) return;
  window.__ccRelay = true;

  /**
   * Deliberately short, and deliberately without the Slack messages. Anything relayed here is
   * reachable by every script on the page, and posting as the user - or reading which channels
   * and people they have - is not something a page may ask for. That is why the panel offers
   * Slack only where it runs in the isolated world.
   */
  const RELAYED = new Set(['ping', 'capture']);

  // Reloading the extension orphans every content script already running: the script keeps
  // executing but its chrome.runtime link is dead. `chrome.runtime.id` disappearing is how
  // that is detected.
  const connected = () => { try { return Boolean(chrome.runtime?.id); } catch { return false; } };

  /**
   * The toolbar menu's settings, which the overlay here cannot read for itself. Said both ways: as
   * an attribute, for an overlay that has not started yet, and as a message, for one that has. A
   * page script can forge either - and all that buys it is hiding the overlay or its pins.
   */
  const passSettings = () => chrome.storage.local.get(['off', 'idlePins']).then((v) => {
    const settings = { off: (v?.off || []).includes(location.origin), idlePins: v?.idlePins === true };
    document.documentElement.dataset.ccSettings = JSON.stringify(settings);
    window.postMessage({ __cc: 'settings', settings }, '*');
  }, () => {});
  try {
    passSettings();
    chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.off || c.idlePins)) passSettings(); });
  } catch {}

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__cc !== 'req' || !RELAYED.has(e.data.type)) return;
    const { id, type, payload } = e.data;
    const reply = (p) => window.postMessage({ __cc: 'res', id, payload: p }, '*');

    if (!connected()) {
      return reply({ error: 'the extension was reloaded - refresh this page' });
    }
    try {
      // Ping round-trips to the service worker rather than being answered here. Answering
      // locally reported a healthy extension even when this script was orphaned, so the
      // overlay believed capture would work and every screenshot silently timed out.
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        const err = chrome.runtime.lastError;
        reply(err ? { error: err.message } : res);
      });
    } catch (err) {
      reply({ error: String(err?.message || err) });
    }
  });
})();
