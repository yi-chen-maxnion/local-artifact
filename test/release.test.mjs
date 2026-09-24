import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FILES, TRAILER, bumpBuild, bumpJson, bumpLock, bumped, release, validateVersion, versionsIn,
} from '../scripts/release.mjs';
import { ROOT } from './helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** The lines two texts differ on, pairwise - every bump here changes lines, never adds any. */
const changed = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  assert.equal(x.length, y.length, 'a bump must not add or remove lines');
  return x.map((line, i) => [line, y[i]]).filter(([l, r]) => l !== r);
};

describe('validateVersion', () => {
  test('takes a version strictly greater than the current one', () => {
    assert.equal(validateVersion('0.2.0', '0.1.0'), '0.2.0');
    assert.equal(validateVersion('0.1.1', '0.1.0'), '0.1.1');
    assert.equal(validateVersion('1.0.0', '0.99.99'), '1.0.0');
    assert.equal(validateVersion('0.10.0', '0.9.0'), '0.10.0');
  });

  // Equal is an update nobody receives; lower is a downgrade everything downstream refuses.
  test('refuses the same version and a lower one', () => {
    assert.throws(() => validateVersion('0.1.0', '0.1.0'), /not greater than the current 0\.1\.0/);
    assert.throws(() => validateVersion('0.0.9', '0.1.0'), /not greater/);
    assert.throws(() => validateVersion('0.9.0', '0.10.0'), /not greater/);
  });

  test('refuses anything that is not plain x.y.z', () => {
    for (const bad of ['v0.2.0', '0.2', '0.2.0-beta.1', '0.2.0+b', ' 0.2.0', '00.2.0', '', undefined]) {
      assert.throws(() => validateVersion(bad, '0.1.0'), /not a version/, String(bad));
    }
    assert.throws(() => validateVersion('0.2.0', 'garbage'), /current version is unreadable/);
  });
});

describe('the bump, file by file', () => {
  test('plugin.json: the version line and nothing else, layout kept', () => {
    const before = read('.claude-plugin/plugin.json');
    const after = bumpJson(before, '7.8.9');
    assert.equal(JSON.parse(after).version, '7.8.9');
    const diff = changed(before, after);
    assert.equal(diff.length, 1);
    assert.match(diff[0][1], /^ {2}"version": "7\.8\.9",$/);
  });

  test('manifest.json and package.json the same way', () => {
    for (const rel of ['extension/manifest.json', 'package.json']) {
      const before = read(rel);
      const after = bumpJson(before, '7.8.9');
      assert.equal(JSON.parse(after).version, '7.8.9', rel);
      assert.equal(changed(before, after).length, 1, rel);
    }
  });

  test('a nested "version" is not the one, and a file without one at the top is refused', () => {
    const text = '{\n  "name": "x",\n  "version": "1.0.0",\n  "dep": {\n    "version": "5.5.5"\n  }\n}\n';
    const after = bumpJson(text, '2.0.0');
    assert.equal(JSON.parse(after).dep.version, '5.5.5');
    assert.throws(() => bumpJson('{\n  "name": "x",\n  "dep": {\n    "version": "5.5.5"\n  }\n}\n', '2.0.0'), /found 0/);
  });

  test('package-lock.json: the top and the root package, never a dependency', () => {
    const before = read('package-lock.json');
    const after = bumpLock(before, '7.8.9');
    const j = JSON.parse(after);
    assert.equal(j.version, '7.8.9');
    assert.equal(j.packages[''].version, '7.8.9');
    const diff = changed(before, after);
    assert.equal(diff.length, 2);
    for (const [, line] of diff) assert.match(line, /"version": "7\.8\.9",$/);
    // Not in npm's layout: refused rather than reformatted into a diff nobody asked for.
    assert.throws(() => bumpLock(JSON.stringify(JSON.parse(before)), '7.8.9'), /npm's layout/);
  });

  test("background.js: the one BUILD line, and only when there is exactly one", () => {
    const before = read('extension/background.js');
    const after = bumpBuild(before, '7.8.9');
    const diff = changed(before, after);
    assert.deepEqual(diff.map(([, r]) => r), ["const BUILD = '7.8.9';"]);
    assert.throws(() => bumpBuild('const X = 1;\n', '7.8.9'), /found 0/);
    assert.throws(() => bumpBuild("const BUILD = '1.0.0';\nconst BUILD = '1.0.0';\n", '7.8.9'), /found 2/);
  });

  test('every file of this repo bumps and reads back as the new version', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bump-'));
    for (const [rel] of FILES) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
    }
    for (const [rel, text] of bumped(tmp, '7.8.9')) fs.writeFileSync(path.join(tmp, rel), text);
    for (const [file, v] of Object.entries(versionsIn(tmp))) assert.equal(v, '7.8.9', file);
  });
});

/**
 * The whole sequence, against a throwaway repository with a bare one as its origin - never this
 * one. The checks (`npm test`, `npm run check`) are left out: they are this repo's, and this test
 * is about what the script does with git.
 */
describe('release(), end to end in a scratch repository', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A repo on dev one commit ahead of main, both pushed, holding this repo's version files. */
  function scratch() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-release-'));
    const remote = path.join(base, 'remote.git');
    const work = path.join(base, 'work');
    git(base, 'init', '--bare', '-b', 'main', remote);
    git(base, 'init', '-b', 'main', work);
    for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.invalid'],
      ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) {
      git(work, 'config', k, v);
    }
    for (const [rel] of FILES) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(work, rel));
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'first');
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'dev');
    fs.writeFileSync(path.join(work, 'work.txt'), 'a change on dev');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'work');
    git(work, 'push', '-q', 'origin', 'dev');
    return { work, remote };
  }

  const current = versionsIn(ROOT)['.claude-plugin/plugin.json'];
  const next = current.replace(/\d+$/, (n) => String(Number(n) + 1));

  test('commits the bump on dev, fast-forwards main, tags it, pushes all three, and ends on dev', () => {
    const { work, remote } = scratch();
    const lines = [];
    release({ version: next, root: work, checks: [], log: (l) => lines.push(l) });
    // Each file read on its own terms, not through FILES: a source dropped from that list would
    // otherwise be skipped by the very check meant to catch it.
    const text = (rel) => fs.readFileSync(path.join(work, rel), 'utf8');
    for (const rel of ['.claude-plugin/plugin.json', 'extension/manifest.json', 'package.json']) {
      assert.equal(JSON.parse(text(rel)).version, next, rel);
    }
    const lock = JSON.parse(text('package-lock.json'));
    assert.deepEqual([lock.version, lock.packages[''].version], [next, next]);
    assert.match(text('extension/background.js'), new RegExp(`^const BUILD = '${next.replace(/\./g, '\\.')}';$`, 'm'));
    assert.equal(git(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev');
    assert.equal(git(work, 'status', '--porcelain'), '');
    const head = git(work, 'rev-parse', 'dev');
    assert.equal(git(work, 'rev-parse', 'main'), head);
    assert.equal(git(work, 'rev-parse', `v${next}^{commit}`), head);
    assert.equal(git(work, 'cat-file', '-t', `v${next}`), 'tag'); // annotated
    assert.equal(git(work, 'log', '-1', '--format=%B', 'dev'), `release v${next}\n\n${TRAILER}`);
    // Only the version files, in that commit.
    assert.deepEqual(git(work, 'show', '--name-only', '--format=', 'dev').split('\n').sort(), [
      '.claude-plugin/plugin.json', 'extension/background.js', 'extension/manifest.json',
      'package-lock.json', 'package.json',
    ]);
    // And the remote has all three.
    assert.equal(git(remote, 'rev-parse', 'main'), head);
    assert.equal(git(remote, 'rev-parse', 'dev'), head);
    assert.equal(git(remote, 'rev-parse', `v${next}^{commit}`), head);
    assert.equal(lines.at(-1), `released v${next}`);
  });

  test('a dry run prints every step and changes nothing', () => {
    const { work, remote } = scratch();
    const before = { head: git(work, 'rev-parse', 'HEAD'), main: git(work, 'rev-parse', 'main'), remote: git(remote, 'rev-parse', 'main') };
    const lines = [];
    const ran = [];
    const run = (cmd, args, opts) => {
      ran.push([cmd, ...args].join(' '));
      return execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    };
    release({ version: next, root: work, dryRun: true, checks: [['npm', ['test']]], log: (l) => lines.push(l), run });
    // Only reads ran: everything else was printed.
    for (const cmd of ran) assert.match(cmd, /^git (rev-parse|status|tag --list|merge-base)/, cmd);
    const text = lines.join('\n');
    for (const want of ['would run  npm test', `would bump  .claude-plugin/plugin.json ${current} -> ${next}`,
      'would bump  extension/background.js', 'would run  git commit', 'would run  git checkout main',
      'would run  git merge --ff-only dev', `would run  git tag -a v${next}`,
      `would run  git push --atomic origin main dev v${next}`, 'would run  git checkout dev']) {
      assert.ok(text.includes(want), `missing: ${want}\n${text}`);
    }
    assert.equal(git(work, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(work, 'rev-parse', 'main'), before.main);
    assert.equal(git(remote, 'rev-parse', 'main'), before.remote);
    assert.equal(git(work, 'status', '--porcelain'), '');
    assert.equal(git(work, 'tag', '--list'), '');
  });

  test('refuses off dev, on a dirty tree, and for a version that is not greater', () => {
    const { work } = scratch();
    const go = (version = next) => release({ version, root: work, checks: [], log: () => {} });
    assert.throws(() => go(current), /not greater/);
    fs.writeFileSync(path.join(work, 'work.txt'), 'uncommitted');
    assert.throws(() => go(), /not clean/);
    git(work, 'checkout', '-q', '--', 'work.txt');
    git(work, 'checkout', '-q', 'main');
    assert.throws(() => go(), /cut from dev, and this is main/);
    git(work, 'checkout', '-q', 'dev');
    // Nothing was written by any of them.
    assert.equal(versionsIn(work)['.claude-plugin/plugin.json'], current);
    assert.equal(git(work, 'tag', '--list'), '');
  });

  // A main with a commit dev lacks would fail the fast-forward after the commit; it is refused first.
  test('refuses when main is not an ancestor of dev', () => {
    const { work } = scratch();
    git(work, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(work, 'hotfix.txt'), 'straight onto main');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'hotfix');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'dev');
    const head = git(work, 'rev-parse', 'HEAD');
    assert.throws(() => release({ version: next, root: work, checks: [], log: () => {} }), /main is not an ancestor of dev/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), head);
  });
});
