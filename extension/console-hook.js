/**
 * Page-world half of the console capture.
 *
 * The overlay runs in the extension's isolated world, where `console` is a different object and
 * the page's errors are not its own - so this small piece runs in the page itself and hands each
 * line over as a DOM event. The bridge serves the same file to the pages it serves, where the
 * overlay runs in the page world and listens for the same event.
 *
 * It is wrapped around someone else's console, so it must never be what breaks the page: every
 * step is guarded, and an argument is cut down before it is turned into a string. A script on
 * the page can dispatch these events too; all that reaches is the `console` field of a comment
 * the user is sending.
 */
(() => {
  if (window.__ccConsoleHook) return;
  window.__ccConsoleHook = true;

  const MAX = 220;
  const send = (line) => {
    try { window.dispatchEvent(new CustomEvent('cc:console', { detail: line.slice(0, MAX) })); } catch {}
  };
  // Never String() an arbitrary object: it can throw (Object.create(null)), and a large array
  // would be serialised whole only to be cut down to a line.
  const show = (x) => {
    try {
      if (typeof x === 'string') return x.slice(0, MAX);
      if (x instanceof Error) return String(x.stack || x.message).slice(0, MAX);
      if (x && typeof x === 'object') return Object.prototype.toString.call(x);
      return String(x);
    } catch {
      return '[unprintable]';
    }
  };

  for (const m of ['error', 'warn']) {
    const orig = console[m];
    console[m] = function (...args) {
      try { send(`${m}: ${args.slice(0, 8).map(show).join(' ')}`); } catch {}
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e) => send(`error: ${show(e.message)}`));
})();
