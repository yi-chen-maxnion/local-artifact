import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

/**
 * The one failure in this plugin that is completely silent.
 *
 * The host arms a monitor by comparing `when` with the name it emits on a skill invocation -
 * `<plugin>:<skill>`, as an exact string. A mismatch, whether from a renamed command file, a bare
 * name or a renamed plugin, warns nowhere: the monitor is simply never started, and every comment
 * sent afterwards is accepted by the bridge and read by nobody. Nothing in the running system can
 * notice that, so it is noticed here, from the files on disk.
 *
 * Nothing below is written down twice: the command name comes out of the trigger, and everything
 * else has to be on disk under that name. Renaming the command file alone fails; changing the
 * trigger alone fails; renaming both together - the only safe way to do it - passes.
 */
describe('the monitor trigger matches the command on disk', () => {
  const read = (...rel) => fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
  const plugin = JSON.parse(read('.claude-plugin', 'plugin.json'));
  const monitors = JSON.parse(read('monitors', 'monitors.json'));

  test('there is exactly one trigger, and it is plugin-namespaced', () => {
    assert.equal(monitors.length, 1);
    assert.match(monitors[0].when, new RegExp(`^on-skill-invoke:${plugin.name}:[a-z][a-z0-9-]*$`));
  });

  test('the command it names exists, and runs the script of the same name', () => {
    const name = monitors[0].when.slice(`on-skill-invoke:${plugin.name}:`.length);
    const commands = fs.readdirSync(path.join(ROOT, 'commands'));
    assert.ok(commands.includes(`${name}.md`), `arms on ${name}, but commands holds ${commands.join(', ')}`);
    // The command file and the script have to travel together too: the command is what the host
    // invokes, the script is what actually connects the session.
    assert.match(read('commands', `${name}.md`), new RegExp(`scripts/${name}\\.mjs`));
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', `${name}.mjs`)), `scripts/${name}.mjs is missing`);
  });
});
