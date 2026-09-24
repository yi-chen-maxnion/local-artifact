#!/usr/bin/env node
/**
 * /connect - make this session the one the browser sends comments to.
 *
 * It takes no target. With the extension installed every page the user opens already carries the
 * comment button; all it needs is to know whose session that page reports to, which is what the
 * claim here says. This is also the only place the bridge daemon gets started.
 */
import { execFileSync } from 'node:child_process';
import { EXT_DIR, PORT, bridge, ensureDaemon, health, resolveSession, sleep } from '../lib/common.mjs';
import { extensionStatus } from '../lib/format.mjs';

// Refused rather than ignored, and before anything is started: someone naming a file here is
// asking for it to be opened, and would otherwise be told only that setup succeeded.
if (process.argv.length > 2) {
  console.error('connect: /connect takes no argument - it connects this session to the browser,');
  console.error('         and nothing more. Claude opens files for review itself, so there is no');
  console.error('         target to pass here.');
  process.exit(2);
}

const session = resolveSession();
if (!session.key) {
  console.error('connect: could not find the claude process this command runs under.');
  console.error('         Comments are routed to a session by that process id, so none would arrive here.');
  process.exit(1);
}

/**
 * The extension speaks to 127.0.0.1:4517 and holds that origin as a literal - it cannot read an
 * environment variable of ours. So on any other port the daemon is up, the session is connected,
 * and nothing whatever is on the pages: this variable is for the test suite, and saying so here
 * is cheaper than the hour someone would otherwise spend looking at the extension.
 */
if (PORT !== 4517) {
  console.error(`WARNING  LOCAL_ARTIFACT_PORT=${PORT} - the extension only talks to 127.0.0.1:4517; `
    + 'this port is for the test suite');
}

try {
  const { note } = await ensureDaemon();
  await bridge('/register', { body: { key: session.key, pid: session.pid, cwd: session.cwd, repo: session.repo } });
  // The claim takes no origin, so every origin nobody opened explicitly falls to this session -
  // which is what "any page you open" means.
  const connected = await bridge('/connect', { body: { key: session.key } });

  // The monitor is armed by the host on skill invoke, not by us. If the arm trigger in
  // monitors.json ever stops matching this command's name, comments would vanish silently -
  // so say so here rather than let the user discover it by not receiving anything.
  let monitorUp = false;
  let h = null;
  for (let i = 0; i < 12 && !monitorUp; i++) {
    h = await health();
    monitorUp = h?.sessions?.find((s) => s.key === session.key)?.clients > 0;
    if (!monitorUp) await sleep(250);
  }

  // What the bridge knows about the extension, in the same words `ctl.mjs status` uses.
  const extension = extensionStatus(h, EXT_DIR);
  const seen = Boolean(h?.extension?.seenAt);
  /**
   * The folder to install from, on the clipboard - only when there is something to install. The
   * path sits under a hidden directory, which Chrome's Load unpacked picker will not show, and
   * which the person would otherwise type by hand; Cmd+Shift+G in the picker opens a box that
   * takes a pasted path. Never when the extension is there: the clipboard is the user's, and a
   * command that overwrote it for nothing would be a command that loses what they had copied.
   */
  const copied = !seen && copyToClipboard(h?.extDir?.path || EXT_DIR);

  console.log(`connect  session ${session.key}${session.repo ? ` (${session.repo})` : ''}`);
  // The other session is never told, and its user is about to stop receiving the comments they
  // were receiving a moment ago. This clause is the whole of the warning either of them gets.
  const taken = connected.previous ? ` (taken from ${connected.previous.repo || connected.previous.key})` : '';
  console.log(`  browser this session${taken} - with the extension installed, ANY page you open now`);
  console.log('          carries the comment button and reports back here. The extension is');
  console.log('          what puts it there, so install it if no button ever appears.');
  console.log(extension);
  if (copied) {
    console.log('           that folder is on the clipboard: in the Load unpacked picker press');
    console.log('           Cmd+Shift+G, then Cmd+V, then Return');
  }
  // An old session meeting a newer bridge: it keeps it, and says the session is the old thing.
  if (note) console.log(`  ${note}`);
  // Last, because this is the line the slash command reads back to the user.
  console.log(`  monitor ${monitorUp ? 'listening' : 'NOT ATTACHED - comments will not reach this session'}`);
  if (!monitorUp) {
    console.log('          The plugin monitor arms on /connect. If this persists, the "when"');
    console.log('          trigger in monitors/monitors.json is not');
    console.log('          on-skill-invoke:local-artifact:connect, which matches nothing silently.');
  }

  /**
   * Last, and after everything has been printed: the session IS registered and connected, and
   * the rest of the output is true. What is not true is that anything will come back, because
   * nothing puts a button on a page - so the command fails, loudly, rather than let a setup that
   * cannot work read as a setup that did.
   */
  if (!seen) {
    console.error(extension);
    process.exit(3);
  }
} catch (e) {
  console.error(`connect: ${e.message}`);
  process.exit(1);
}

/** macOS's clipboard. False, and nothing said, where there is no `pbcopy` or it fails. */
function copyToClipboard(text) {
  try {
    execFileSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
