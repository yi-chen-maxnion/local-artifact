#!/usr/bin/env node
/**
 * /disconnect - this session stops receiving comments. With --stop, the bridge stops as well.
 *
 * The monitor is left exactly as it is, still attached. The host arms it the first time /connect
 * runs and promises nothing about arming one that exited - so a monitor that went away here
 * could leave the next /connect in this session connected to nothing. What changes is the daemon's answer to
 * "whose comment is this", which is never this session again until it runs /connect.
 *
 * Nothing here starts a daemon: there is nothing to disconnect from one that is not running.
 */
import { bridge, health, resolveSession, untilStopped } from '../lib/common.mjs';
import { stoppedLine } from '../lib/format.mjs';

const args = process.argv.slice(2);
const stop = args[0] === '--stop';
if (args.length > (stop ? 1 : 0)) {
  console.error(`disconnect: usage: /disconnect [--stop]  (got ${JSON.stringify(args.join(' '))})`);
  process.exit(2);
}

const session = resolveSession();
if (!session.key) {
  console.error('disconnect: could not find the claude process this command runs under.');
  console.error('            Comments are routed to a session by that process id, so none reach it anyway.');
  process.exit(1);
}

const h = await health();
if (!h) {
  console.log('disconnect  nothing to do - the bridge is not running, so no session receives comments');
  process.exit(0);
}
if (!h.sessions) {
  // Up, but our token was not accepted: its token file has gone, and it restores it within 30s.
  console.error('disconnect: the bridge did not accept the control token. It restores its token file');
  console.error('            within 30 seconds; run this again then.');
  process.exit(1);
}

const me = `session ${session.key}${session.repo ? ` (${session.repo})` : ''}`;
const repoOf = (s) => s.repo || s.key;

try {
  const d = await bridge('/disconnect', { body: { key: session.key } });
  if (d.already) {
    console.log(`disconnect  ${me} - already disconnected; nothing changed`);
  } else if (!d.registered) {
    // Marked all the same: a monitor that has not come back since a restart would otherwise be
    // handed the browser the moment it did.
    console.log(`disconnect  ${me} - was not connected; it will not be handed the browser either`);
  } else {
    console.log(`disconnect  ${me} - receives no comments from now on`);
  }

  if (!stop) {
    // Who has them now, because the user's next comment goes there whether or not they know it.
    let browser;
    if (d.primary) {
      browser = d.held
        ? `comments now go to ${repoOf(d.primary)}, the session connected most recently`
        : `comments go to ${repoOf(d.primary)}, as before`;
    } else {
      browser = 'no session receives comments; run /connect in the one you want';
    }
    console.log(`   browser  ${browser}`);
    console.log('            /connect here takes the browser back.');
    process.exit(0);
  }

  let s;
  try {
    s = await bridge('/shutdown', { body: {} });
  } catch (e) {
    if (e.status !== 503) throw e;
    console.log('      stop  the bridge was already stopping');
    process.exit(0);
  }
  await untilStopped();
  console.log(`      stop  ${stoppedLine(s.sessions, session.key)}`);
} catch (e) {
  console.error(`disconnect: ${e.message}`);
  process.exit(1);
}
