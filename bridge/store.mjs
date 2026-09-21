import fs from 'node:fs';
import path from 'node:path';
import { ensureScratch, scratchDir, watermarkFile } from '../lib/common.mjs';

const REPLAY_MAX = 50;

/**
 * The bytes behind a `data:` URL, or null if it is not one of ours. Split out because the
 * screenshot has two readers now: this file, which parks it next to the session, and the Slack
 * upload, which must not depend on a temp file the monitor deletes on its way out.
 */
export function decodeShot(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const [, kind, b64] = m;
  return { ext: kind === 'jpeg' ? 'jpg' : kind, buf: Buffer.from(b64, 'base64') };
}

/**
 * Per-session scratch state. Everything here is an intermediate: screenshots the model
 * may want to look at, and a short replay buffer so a monitor that reconnects after a
 * daemon restart does not miss an event. The conversation is the durable record.
 */
export class Store {
  #replay = new Map(); // sessionKey -> payload[]
  #counters = new Map(); // previewId -> n

  /**
   * The next comment number for a page.
   *
   * Numbered per page, not per origin. Markers are drawn only on the page they were left on, so
   * an origin-wide counter meant walking to a second route of the same app and finding a single
   * marker numbered #6 with nothing before it - a number that referred to a page you were no
   * longer looking at.
   *
   * `after` is the highest number the PAGE still has a marker for. The counter lives on the
   * daemon and the markers live in the browser, and the two can drift apart - a scratch
   * directory cleared by the OS, a state file from before counters were saved, a preview id
   * adopted from an older format. Whenever they disagree the page is the one holding the
   * evidence, so it wins, and a second "#1" can never be issued over a pin that already says #1.
   */
  next(previewId, page = '', after = 0) {
    const key = `${previewId}|${page}`;
    const from = Math.max(this.#counters.get(key) || 0, Number(after) || 0);
    const n = from + 1;
    this.#counters.set(key, n);
    return n;
  }

  /**
   * Comment numbers have to outlive the daemon now that a preview id is stable for an origin
   * rather than minted anew each time a page is opened. A restart used to reset every counter to
   * zero, which was harmless when the id was new anyway; against a page that still has pin #3, it
   * would hand out #1 a second time. The daemon saves these alongside the previews.
   */
  counters() {
    return [...this.#counters.entries()];
  }

  /** `keep(previewId)` says which previews still exist; counters for the rest are left behind. */
  restoreCounters(entries, keep) {
    for (const [key, n] of entries || []) {
      if (typeof key !== 'string' || !Number.isFinite(n)) continue;
      if (keep(key.split('|')[0])) this.#counters.set(key, Number(n));
    }
  }

  dropCounter(previewId) {
    for (const key of this.#counters.keys()) {
      if (key === previewId || key.startsWith(`${previewId}|`)) this.#counters.delete(key);
    }
  }

  /**
   * Persist the screenshot next to the session that will read it. Returns its path, or null.
   *
   * Named by the daemon's own sequence rather than by the comment number: those restart at 1 on
   * every page now, so two pages of the same app would write over each other's captures.
   */
  writeShot(sessionKey, previewId, n, dataUrl) {
    const shot = decodeShot(dataUrl);
    if (!shot) return null;
    const dir = ensureScratch(sessionKey);
    const file = path.join(dir, `${previewId}-${String(n).padStart(4, '0')}.${shot.ext}`);
    fs.writeFileSync(file, shot.buf);
    return file;
  }

  push(sessionKey, payload) {
    const buf = this.#replay.get(sessionKey) || [];
    buf.push(payload);
    while (buf.length > REPLAY_MAX) buf.shift();
    this.#replay.set(sessionKey, buf);
  }

  /** Everything buffered past `from` - what a monitor holding a real watermark is owed. */
  after(sessionKey, from) {
    return (this.#replay.get(sessionKey) || []).filter((p) => p.seq > from);
  }

  /**
   * The same question asked the old way, where 0 means "I am new, send me nothing".
   *
   * That conflation is why `after` exists: a monitor is at 0 both when it has never seen this
   * daemon and when it has been attached for hours without a comment to print. It stays exactly
   * as it is because monitors outlive daemon upgrades, and one that still asks this way must keep
   * getting nothing rather than a replay of what its predecessor already printed.
   */
  since(sessionKey, lastSeq) {
    return lastSeq ? this.after(sessionKey, lastSeq) : [];
  }

  forget(sessionKey) {
    this.#replay.delete(sessionKey);
    try {
      fs.rmSync(scratchDir(sessionKey), { recursive: true, force: true });
    } catch {}
    // The monitor's watermark outlives the monitor on purpose, so the session ending is the only
    // thing that can clear it - otherwise a pid handed out again inherits a stale one.
    try {
      fs.rmSync(watermarkFile(sessionKey), { force: true });
    } catch {}
  }
}
