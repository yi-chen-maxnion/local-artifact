#!/usr/bin/env node
/**
 * /preview - make this session the one the browser sends comments to.
 *
 * It takes no target. With the extension installed every page the user opens already carries the
 * comment button; all it needs is to know whose session that page reports to, which is what the
 * claim here says. This is also the only place the bridge daemon gets started.
 */
import { bridge, ensureDaemon, health, resolveSession, sleep } from '../lib/common.mjs';

// Refused rather than ignored, and before anything is started: someone typing the old form is
// asking for a target to open, and would otherwise be told only that setup succeeded.
if (process.argv.length > 2) {
  console.error('preview: takes no argument - it sets this session up, and nothing more.');
  console.error('         With the extension installed, every page you then open in the browser');
  console.error('         carries the comment button and reports back to this session.');
  process.exit(2);
}

const session = resolveSession();
if (!session.key) {
  console.error('preview: could not find the claude process this command runs under.');
  console.error('         Comments are routed to a session by that process id, so none would arrive here.');
  process.exit(1);
}

try {
  await ensureDaemon();
  await bridge('/register', { body: { key: session.key, pid: session.pid, cwd: session.cwd, repo: session.repo } });
  // The claim takes no origin, so every origin nobody opened explicitly falls to this session -
  // which is what "any page you open" means.
  await bridge('/claim', { body: { key: session.key } });

  // The monitor is armed by the host on skill invoke, not by us. If the arm trigger in
  // monitors.json ever stops matching this command's name, comments would vanish silently -
  // so say so here rather than let the user discover it by not receiving anything.
  let monitorUp = false;
  for (let i = 0; i < 12 && !monitorUp; i++) {
    const h = await health();
    monitorUp = h?.sessions?.find((s) => s.key === session.key)?.clients > 0;
    if (!monitorUp) await sleep(250);
  }

  console.log(`setup    session ${session.key}${session.repo ? ` (${session.repo})` : ''}`);
  console.log('  browser this session - with the extension installed, ANY page you open now');
  console.log('          carries the comment button and reports back here. The extension is');
  console.log('          what puts it there, so install it if no button ever appears.');
  // Last, because this is the line the slash command reads back to the user.
  console.log(`  monitor ${monitorUp ? 'listening' : 'NOT ATTACHED - comments will not reach this session'}`);
  if (!monitorUp) {
    console.log('          The plugin monitor arms on /preview. If this persists, the');
    console.log('          "when" trigger in monitors/monitors.json does not match this command.');
  }
} catch (e) {
  console.error(`preview: ${e.message}`);
  process.exit(1);
}
