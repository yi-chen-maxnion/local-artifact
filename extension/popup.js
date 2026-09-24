/**
 * The menu under the toolbar icon. The two switches only read and write storage - the list of
 * origins turned off, and whether pins show outside comment mode. Every overlay follows storage
 * on its own, and the service worker repaints badges from it, so nothing there has to reach a tab.
 *
 * Slack is the exception, and it is here for a reason: connecting it is the one part of setting
 * this up that does not happen on the page, and a teammate who only ever touches the extension
 * should not have to learn a slash command for it. The worker does the talking; this never sees
 * a token.
 */
const originOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
};

async function main() {
  const $ = (id) => document.getElementById(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origin = originOf(tab?.url || '');
  const { off = [], idlePins } = await chrome.storage.local.get(['off', 'idlePins']);

  $('origin').textContent = origin || '這個頁面';
  $('site').checked = Boolean(origin) && !off.includes(origin);
  $('pins').checked = idlePins === true; // off until asked for: pins show in comment mode regardless
  if (!origin) {
    // chrome://, the web store, a file: URL - nothing is ever injected there.
    $('site').disabled = true;
    $('site-row').classList.add('disabled');
    $('site-note').textContent = '這個頁面無法使用';
  }

  $('site').addEventListener('change', async () => {
    // Read again rather than reusing the list above: another window may have changed it since.
    const now = new Set((await chrome.storage.local.get('off')).off || []);
    if ($('site').checked) now.delete(origin); else now.add(origin);
    await chrome.storage.local.set({ off: [...now] });
  });
  $('pins').addEventListener('change', () => chrome.storage.local.set({ idlePins: $('pins').checked }));

  const ask = (type) => chrome.runtime.sendMessage({ type }).catch((e) => ({ error: String(e?.message || e) }));

  /**
   * The line under "Slack" is the account, not an explanation: `Name@Workspace` once there is
   * one, and nothing at all before that - an unconnected row explains itself with its button.
   * A problem is the exception, since that is the one thing the button cannot say.
   */
  const note = (text) => {
    const el = $('slack-note');
    el.textContent = text || '';
    el.hidden = !text;
  };

  /**
   * What the bridge could not be asked, in the words the Slack row uses for the same failure.
   * On the code, never on the sentence: the worker's English is for a person to read and gets
   * reworded, and matching it is how this menu would quietly fall back to "cannot get status".
   * A 404 is the other shape of the same problem - a daemon from older code, which /connect
   * replaces on its next run - so both point at the same thing to do.
   */
  const unreachable = (s) => (s?.code === 'bridge_unreachable' || s?.code === 'bridge_timeout' || s?.status === 404
    ? 'Bridge 沒有在執行或版本過舊，請執行 /connect'
    : '無法取得狀態');

  /**
   * Which session a comment from this browser would reach. The button on the page looks exactly
   * the same whether one is connected or not, and this is the only place that can say which it
   * is without a comment being sent to find out.
   */
  async function paintSession() {
    const s = await ask('status');
    const el = $('session-note');
    if (!s || s.error) { el.textContent = unreachable(s); return; }
    el.textContent = s.connected
      ? `-> ${s.repo || '已連線的 session'}`
      : '沒有連線的 Claude session，請執行 /connect';
  }

  /**
   * Four states, each with the one thing to do about it: no bridge, no app configured, connected,
   * not connected. The button is hidden where there is nothing the menu can do.
   */
  async function paintSlack() {
    const s = await ask('slackStatus');
    const btn = $('slack-btn');
    btn.hidden = true;
    btn.disabled = false;
    btn.className = 'btn';
    if (!s || s.error) return note(unreachable(s));
    if (!s.configured) return note('尚未設定 Slack App，見 slack-app.json');
    if (s.connected) {
      note(`${s.user}${s.team ? `@${s.team}` : ''}`);
      btn.textContent = '中斷連線';
      btn.classList.add('ghost');
      btn.hidden = false;
      btn.onclick = async () => {
        btn.disabled = true;
        await ask('slackLogout');
        paintSlack();
      };
      return;
    }
    note('');
    btn.textContent = '連線';
    btn.classList.add('go');
    btn.hidden = false;
    btn.onclick = async () => {
      btn.disabled = true;
      // Opening the authorisation tab closes this menu, so there is nothing to update here;
      // the page Slack returns to says what happened.
      const j = await ask('slackLogin');
      if (j?.error) { note(j.error); btn.disabled = false; }
    };
  }

  /**
   * The running version, from the worker: after a browser restart the manifest can already say the
   * new one while the worker still runs the old code, and the worker is what anybody debugging
   * needs to know about. The manifest is the fallback for a worker that did not answer.
   */
  async function paintVersion() {
    const v = await ask('version');
    let build = v?.build;
    if (!build) try { build = chrome.runtime.getManifest().version; } catch {}
    $('ver').textContent = v?.ready
      ? `v${build || '?'} - ${v.ready} 已就緒，送出留言後自動更新`
      : `v${build || '?'}`;
  }

  paintSession();
  paintSlack();
  paintVersion();
}

main();
