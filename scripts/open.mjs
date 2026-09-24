#!/usr/bin/env node
/**
 * open - put a file in front of the user, in the browser, with the comment button on it.
 *
 * This is Claude's own gesture, not a command the user runs: having produced something whose
 * point is to be looked at - a report, a rendered note, a diagram - it opens the file here, the
 * bridge serves it under /p/<id>/, and the extension injects the overlay as on any other page.
 * Comments come back to the session that is connected to the browser.
 *
 * It never calls ensureDaemon. A daemon this command had to start would be proof that /connect
 * had never run, and the file would open into a browser whose comments reach nobody. So every
 * precondition is checked and named instead - the first one that fails wins, and says what to do.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXT_DIR, bridge, health, openInBrowser, resolveSession } from '../lib/common.mjs';
import { installHint } from '../lib/format.mjs';

/**
 * Every refusal reads the same way: one `open:` line, on stderr, with the reason in it. The exit
 * code says which kind of failure it was - 1 nothing works, 2 the argument, 3 not connected.
 */
function refuse(message, code, ...detail) {
  console.error(`open: ${message}`);
  for (const line of detail) console.error(`      ${line}`);
  process.exit(code);
}

const session = resolveSession();
if (!session.key) {
  refuse('could not find the claude process this command runs under', 1,
    'Comments are routed to a session by that process id, so none would come back here.');
}

const target = process.argv[2];
if (!target) refuse('usage: node scripts/open.mjs <file>', 2);

if (/^https?:\/\//i.test(target)) {
  refuse('web pages need no opening - open it in Chrome yourself; every page already '
    + 'carries the comment button', 2);
}

// Before the daemon is asked anything: there is no version of this that works. An anchor cannot
// be placed inside Chrome's PDF viewer, so a comment on one is a rectangle with nothing to find
// again - and a wrapper around it only hides that.
if (/\.pdf$/i.test(target)) {
  refuse("PDF is not supported - Chrome's PDF viewer admits no anchor", 2,
    'Offer the same content as HTML or markdown instead.');
}

// Resolved here rather than by the daemon: this process is the one with the working directory
// the file was written from, and the daemon's is somewhere else entirely.
const file = path.resolve(target);
let stat = null;
try { stat = fs.statSync(file); } catch {}
if (!stat?.isFile()) refuse(`not a file: ${file}`, 2);

const NOT_CONNECTED = 'run /connect first - this session is not connected to the browser';

const h = await health();
if (!h) refuse(NOT_CONNECTED, 3);

const me = h.sessions?.find((s) => s.key === session.key);
if (!me) refuse(NOT_CONNECTED, 3);
// Registered, but with nothing on its stream: the page would carry the button and the comment
// would be accepted, and no notification would ever reach this session.
if (!me.clients) refuse('the monitor is not attached - run /connect in this session, then try again', 3);
// It ran /disconnect: its comments go nowhere by its own choice, and the rung below would name
// whoever holds the browser as though this session had merely lost it.
if (me.detached) refuse('this session is disconnected - run /connect here to take the browser back, then try again', 3);

if (h.primary !== session.key) {
  const other = h.sessions.find((s) => s.key === h.primary);
  if (!other) refuse(NOT_CONNECTED, 3);
  refuse(`${other.repo || other.key} is the session connected to the browser - run /connect here `
    + 'first, or its comments will go there', 3);
}

// The last rung, and the one that cannot be inferred from this side: no extension has ever
// reached the daemon, so whatever this opens arrives in a browser with no button on it. Every
// other precondition would be met and the file would look exactly as it should.
if (!h.extension) {
  refuse(`the extension has never reached the bridge - ${installHint(h.extDir?.path || EXT_DIR)}`, 3,
    'Then open any page in Chrome once, so the bridge sees it, and try this again.');
}

try {
  const { url } = await bridge('/open', { body: { key: session.key, target: file } });
  openInBrowser(url);
  console.log(`open     ${path.basename(file)}`);
  console.log(`         ${url}`);
  console.log(`comments -> this session (${session.repo})`);
} catch (e) {
  // The daemon's own refusals - not a file, a PDF, a web page - arrive here already worded.
  console.error(`open: ${e.message}`);
  process.exit(1);
}
