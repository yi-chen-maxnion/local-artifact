#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  EXT_DIR, ORIGIN, bridge, ensureDaemon, health, openInBrowser, resolveSession, scratchDir, sleep, untilStopped,
} from '../lib/common.mjs';
import { extensionStatus, stoppedLine } from '../lib/format.mjs';

const cmd = process.argv[2] || 'status';
const session = resolveSession();

/** One line about Slack wherever the bridge's state is reported. */
function slackLine(s) {
  if (!s) return 'slack      (this bridge is too old to know)';
  if (!s.configured) return 'slack      no app configured - see "Posting a comment to Slack" in docs/REFERENCE.md';
  if (!s.connected) return 'slack      not connected - run /slack login';
  const last = s.last?.at
    ? `  last ${s.last.ok ? `posted to ${s.last.label}` : `failed: ${s.last.error}`}`
    : '';
  return `slack      connected as ${s.user}${s.team ? ` in ${s.team}` : ''}${last}`;
}

/**
 * The Slack connection is per person and per machine, not per session or per project: it lives
 * in the daemon, which every session here shares, so this is a one-off rather than something
 * each new session has to repeat.
 */
async function slackCommand(sub) {
  if (sub === 'status') {
    const h = await health();
    if (!h?.ok) return console.log(`bridge     not running (${ORIGIN}) - run /connect first`);
    return console.log(slackLine(h.slack));
  }

  await ensureDaemon();

  if (sub === 'logout') {
    await bridge('/slack/logout', { body: {} });
    return console.log('slack      disconnected - the token is revoked at Slack and deleted here');
  }
  if (sub !== 'login') {
    console.error(`usage: ctl.mjs slack [login|logout|status]  (got ${JSON.stringify(sub)})`);
    process.exit(2);
  }

  const { url } = await bridge('/slack/login', { body: {} });
  openInBrowser(url);
  console.log('slack      authorise in the browser window that just opened');
  console.log(`           ${url}`);
  // Long enough for a login that needs a password and a second factor, short enough to stay
  // inside a single command; /slack status picks up where this leaves off.
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const s = (await health())?.slack;
    if (s?.connected) {
      console.log(`slack      connected as ${s.user}${s.team ? ` in ${s.team}` : ''}`);
      console.log('           The Slack button appears the next time a comment panel opens - no reload.');
      return;
    }
  }
  console.log('slack      still waiting for Slack - finish in the browser, then run /slack status');
}

if (cmd === 'slack') {
  try {
    await slackCommand(process.argv[3] || 'login');
  } catch (e) {
    console.error(`slack: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

let h;
try {
  h = await bridge('/health', { timeout: 1500 });
} catch {
  console.log(`bridge     not running (${ORIGIN})`);
  if (cmd === 'stop') process.exit(0);
  console.log(`session    ${session.key || '(no claude process found)'}  ${session.repo}`);
  console.log('Run /connect to start it.');
  process.exit(0);
}

if (!h.sessions) {
  // Up, but our token was not accepted: its token file has gone, and it restores it within 30s.
  console.log(`bridge     running on ${ORIGIN}, but it did not accept the control token`);
  console.log('It restores its token file within 30 seconds - run this again then.');
} else if (cmd === 'stop') {
  // The daemon's own shutdown rather than a kill: it saves its state, tells every monitor the
  // bridge was stopped on purpose, and answers with who was connected, so this can say who just
  // lost their comments. /disconnect --stop is the same thing from inside a session.
  try {
    const { sessions } = await bridge('/shutdown', { body: {} });
    await untilStopped();
    console.log(`bridge     ${stoppedLine(sessions, session.key)}`);
  } catch (e) {
    console.log(`bridge     ${e.status === 503 ? 'already stopping' : `did not stop: ${e.message}`}`);
    process.exit(e.status === 503 ? 0 : 1);
  }
} else {
  console.log(`bridge     ${ORIGIN}  (pid ${h.pid})`);
  console.log(`session    ${session.key || '(no claude process found)'}  ${session.repo}  ${session.cwd}`);
  const me = h.sessions.find((s) => s.key === session.key);
  console.log(`monitor    ${me ? `connected (${me.clients} stream${me.clients === 1 ? '' : 's'})` : 'NOT registered - is the plugin enabled?'}`);
  const named = (s) => `${s.repo || s.key}${s.detached ? ' (disconnected)' : ''}`;
  console.log(`sessions   ${h.sessions.length} total: ${h.sessions.map(named).join(', ') || '(none)'}`);
  // Which session an otherwise unbound page goes to. With one session this is noise; with
  // two it is the only thing that answers "where did that comment just go?".
  const primary = h.sessions.find((s) => s.key === h.primary);
  const holder = h.primary ? `comments go to ${primary?.repo || h.primary}` : 'no session receives comments';
  // A disconnected session is first, because it is the one answer that is this session's own
  // doing: it will not be handed the browser by anyone else, whoever ends or connects.
  console.log(`browser    ${me?.detached
    ? `not this session - disconnected; /connect to take it back (${holder})`
    : h.primary
      ? (h.primary === session.key ? 'this session' : `${primary?.repo || h.primary} - run /connect here to take it over`)
      : 'not connected - run /connect'}`);
  // Directly under the browser line, because it is the other half of the same question: one says
  // which session a comment would reach, this says whether anything can send one.
  console.log(extensionStatus(h, EXT_DIR));
  // Ids, not ownership: a record is the namespace a page's pins and comment numbers live in,
  // and it belongs to no session - whoever holds the browser above receives their comments.
  const origins = h.previews.filter((p) => p.origin);
  if (origins.length) {
    console.log(`origins    ${origins.length} with ids:`);
    for (const p of origins) console.log(`  ${p.id.slice(0, 6)}  ${p.origin}`);
  }
  const files = h.previews.filter((p) => !p.origin);
  console.log(`previews   ${files.length} file${files.length === 1 ? '' : 's'}${files.length ? ':' : ''}`);
  for (const p of files) console.log(`  ${p.id.slice(0, 6)}  ${String(p.kind).padEnd(9)}${path.basename(p.target)}`);
  console.log(slackLine(h.slack));
  if (session.key) {
    const dir = scratchDir(session.key);
    const shots = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(jpg|png|webp)$/.test(f)) : [];
    console.log(`shots      ${shots.length} in ${dir}`);
  }
}
