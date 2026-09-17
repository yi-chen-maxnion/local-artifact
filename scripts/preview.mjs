#!/usr/bin/env node
/**
 * /preview <path-or-url> - open a target in the browser bound to THIS session.
 *
 * The previewId it gets back is the routing key: comments from that page reach this
 * session and no other. This is also the only place the bridge daemon gets started.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { bridge, ensureDaemon, health, resolveSession, sleep } from '../lib/common.mjs';

const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');
// Joined rather than just the first: the slash command passes its argument unquoted, so a path
// with a space in it arrives as several.
const target = argv.filter((a) => !a.startsWith('--')).join(' ');

if (!target) {
  console.error('usage: preview.mjs <file-or-url> [--no-open]');
  console.error('');
  console.error('  preview.mjs ./report.html            an HTML file, overlay injected by the bridge');
  console.error('  preview.mjs ./spec.pdf               a PDF, wrapped so the overlay sits over it');
  console.error('  preview.mjs http://localhost:5173    a dev server (needs the Chrome extension)');
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

  const isUrl = /^https?:\/\//i.test(target);
  const resolved = isUrl ? target : path.resolve(session.cwd, target);
  const { previewId, url, kind, external } = await bridge('/preview', { body: { key: session.key, target: resolved } });

  if (!noOpen) {
    // Chrome specifically: that is where the extension lives, and captureVisibleTab with it.
    execFile('open', ['-a', 'Google Chrome', url], (err) => {
      if (err) execFile('open', [url], () => {});
    });
  }

  // The monitor is armed by the host on skill invoke, not by us. If the arm trigger in
  // monitors.json ever stops matching this command's name, comments would vanish silently -
  // so say so here rather than let the user discover it by not receiving anything.
  let monitorUp = false;
  for (let i = 0; i < 12 && !monitorUp; i++) {
    const h = await health();
    monitorUp = h?.sessions?.find((s) => s.key === session.key)?.clients > 0;
    if (!monitorUp) await sleep(250);
  }

  console.log(`preview ${previewId}  (${external ? 'external url' : kind})`);
  console.log(`  target  ${resolved}`);
  console.log(`  opened  ${url}`);
  console.log(`  session ${session.key}${session.repo ? ` (${session.repo})` : ''}`);
  console.log(`  monitor ${monitorUp ? 'listening' : 'NOT ATTACHED - comments will not reach this session'}`);
  if (!monitorUp) {
    console.log('          The plugin monitor arms on /preview. If this persists, the');
    console.log('          "when" trigger in monitors/monitors.json does not match this command.');
  }
  if (external) {
    console.log('  browser this session - with the extension installed, ANY page you open now');
    console.log('          carries the comment button and reports back here. Without it, only');
    console.log('          this tab is bound; use the bookmarklet from README.md elsewhere.');
  }
} catch (e) {
  console.error(`preview: ${e.message}`);
  process.exit(1);
}
