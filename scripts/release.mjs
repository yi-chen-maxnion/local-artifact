#!/usr/bin/env node
/**
 * `npm run release <x.y.z> [--dry-run]` - cut a release: the one way a new version reaches anyone.
 *
 * Claude Code updates an installed plugin only when `version` in plugin.json changes, and a new
 * install takes main's HEAD. So main holds releases and nothing else, work happens on `dev`, and a
 * release is: every version source bumped together in one commit on dev, main fast-forwarded to
 * it, an annotated tag, and all three pushed in one atomic push - so the remote never has a main
 * without its tag, which CI refuses.
 *
 * Five places carry the version, and they must agree: plugin.json (what Claude Code compares),
 * the extension's manifest.json (what the daemon's folder sync compares), `BUILD` in the
 * extension's background.js (what the running extension compares with the bridge's
 * x-cc-ext-latest header), and package.json with its lock (what npm says). A test holds them equal
 * on every commit; this is the only thing that moves them.
 *
 * The pure parts - checking a version, rewriting each file's text - are exported and tested on
 * their own. `release()` is the sequence, with the command runner injectable so a test can drive
 * it against a throwaway repository.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** Plain x.y.z, as lib/common.mjs's SEMVER - a release never has a pre-release or build suffix. */
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** The same attribution line every commit on this repo ends with. */
export const TRAILER = 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>';

/** Every file a release rewrites, relative to the repo root, and how. */
export const FILES = [
  ['.claude-plugin/plugin.json', 'json'],
  ['extension/manifest.json', 'json'],
  ['package.json', 'json'],
  ['package-lock.json', 'lock'],
  ['extension/background.js', 'build'],
];

const parts = (v) => SEMVER.exec(v).slice(1).map(Number);

/**
 * `next`, if it may follow `current`; throws with the reason otherwise. Strictly greater, because
 * an equal version is an update nobody receives and a lower one is a downgrade the whole update
 * chain - Claude Code, the daemon, the folder sync, the extension - is built to refuse.
 */
export function validateVersion(next, current) {
  if (!SEMVER.test(String(next || ''))) throw new Error(`not a version: ${JSON.stringify(next)} - expected x.y.z`);
  if (!SEMVER.test(String(current || ''))) throw new Error(`the current version is unreadable: ${JSON.stringify(current)}`);
  const a = parts(next);
  const b = parts(current);
  const cmp = a.findIndex((n, i) => n !== b[i]);
  if (cmp === -1 || a[cmp] < b[cmp]) throw new Error(`${next} is not greater than the current ${current}`);
  return next;
}

/**
 * The top-level `"version"` of a JSON file, changed in the text rather than re-serialised, so the
 * file keeps whatever layout it had - plugin.json keeps its one-line arrays. Top level means the
 * key at two spaces of indent, which is how every one of these files is written; exactly one, or
 * the file has a shape this was not written for.
 */
export function bumpJson(text, version) {
  const re = /^( {2}"version": )"[^"\n]*"/gm;
  const hits = text.match(re) || [];
  if (hits.length !== 1) throw new Error(`expected one top-level "version", found ${hits.length}`);
  const out = text.replace(re, `$1"${version}"`);
  if (JSON.parse(out).version !== version) throw new Error('the rewritten file does not read back as that version');
  return out;
}

/**
 * package-lock.json carries the version twice: at the top, and on the root package (`""`). The
 * dependencies below carry their own `version` keys at deeper indents, so this one goes through
 * JSON - and only after checking that npm's own layout, which is exactly JSON.stringify's with two
 * spaces, is what the file already has, so the diff is those two lines and nothing else.
 */
export function bumpLock(text, version) {
  const j = JSON.parse(text);
  if (`${JSON.stringify(j, null, 2)}\n` !== text) throw new Error('package-lock.json is not in npm\'s layout - run npm install first');
  if (!j.packages?.['']) throw new Error('package-lock.json has no root package');
  j.version = version;
  j.packages[''].version = version;
  return `${JSON.stringify(j, null, 2)}\n`;
}

/** The one `const BUILD = '...';` line of the extension's service worker. */
export const BUILD_LINE = /^const BUILD = '([^'\n]*)';$/gm;

export function bumpBuild(text, version) {
  const hits = text.match(BUILD_LINE) || [];
  if (hits.length !== 1) throw new Error(`expected one "const BUILD = '...';" line, found ${hits.length}`);
  return text.replace(BUILD_LINE, `const BUILD = '${version}';`);
}

/** What each file says its version is, by the same rules the bump uses. */
export function versionsIn(root = ROOT) {
  const out = {};
  for (const [rel, kind] of FILES) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (kind === 'build') {
      out[rel] = new RegExp(BUILD_LINE.source, 'm').exec(text)?.[1] ?? null;
    } else {
      const j = JSON.parse(text);
      out[rel] = j.version ?? null;
      if (kind === 'lock') out[`${rel} packages[""]`] = j.packages?.['']?.version ?? null;
    }
  }
  return out;
}

/** The text of every file after the bump, without writing anything. */
export function bumped(root, version) {
  return FILES.map(([rel, kind]) => {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const fn = { json: bumpJson, lock: bumpLock, build: bumpBuild }[kind];
    try {
      return [rel, fn(text, version)];
    } catch (e) {
      throw new Error(`${rel}: ${e.message}`);
    }
  });
}

/** Runs a command in `cwd`, inheriting the terminal, and returns its trimmed stdout when asked. */
function defaultRun(cmd, args, { cwd, capture = false } = {}) {
  const out = execFileSync(cmd, args, {
    cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  return capture ? out.trim() : '';
}

/**
 * The release, step by step. Everything that can refuse does so before the first write: the
 * branch, a clean tree, the version, the versions agreeing, main being an ancestor of dev (or the
 * fast-forward would fail after the commit), a tag not already there, and the tests. After the
 * commit, a failure leaves the work on dev and says what to run; the push is atomic, so the remote
 * has either all of main, dev and the tag or none of them.
 *
 * `dryRun` reads what it needs, prints every step, and changes nothing - not even a file.
 */
export function release({
  version, root = ROOT, dryRun = false, run = defaultRun, log = console.log,
  checks = [['npm', ['test']], ['npm', ['run', 'check']]],
} = {}) {
  const git = (...args) => run('git', args, { cwd: root, capture: true });
  const step = (cmd, args) => {
    log(`${dryRun ? 'would run' : 'run'}  ${cmd} ${args.join(' ')}`);
    if (!dryRun) run(cmd, args, { cwd: root });
  };

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'dev') throw new Error(`releases are cut from dev, and this is ${branch}`);
  if (git('status', '--porcelain')) throw new Error('the working tree is not clean - commit or stash first');

  const have = versionsIn(root);
  const current = have['.claude-plugin/plugin.json'];
  const disagree = Object.entries(have).filter(([, v]) => v !== current);
  if (disagree.length) {
    throw new Error(`the versions do not agree before the bump: ${Object.entries(have).map(([f, v]) => `${f}=${v}`).join(', ')}`);
  }
  validateVersion(version, current);
  const tag = `v${version}`;
  if (git('tag', '--list', tag)) throw new Error(`tag ${tag} already exists`);

  // Refused here rather than discovered after the commit: if origin's main has moved past ours, or
  // ours is not behind dev, the fast-forward or the atomic push fails and dev is left a commit up.
  step('git', ['fetch', 'origin', '--tags']);
  const ancestor = (a, b) => {
    try { git('merge-base', '--is-ancestor', a, b); return true; } catch { return false; }
  };
  const known = (sha) => {
    try { git('cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; }
  };
  try { git('rev-parse', '--verify', '--quiet', 'refs/heads/main'); } catch {
    throw new Error('there is no local main branch - create it from the last release (or from dev for the first one)');
  }
  /**
   * What the remote holds now, asked of the remote itself (`ls-remote` reads, it changes nothing,
   * so a dry run asks too): the push must be a fast-forward of each branch it names. A branch the
   * remote does not have yet - the first release to an empty repository - has nothing to be
   * behind, and is created by the push. One it has must be contained in ours; a commit of it we
   * have never fetched cannot be, and is refused rather than guessed about.
   */
  for (const [branch, local] of [['main', 'main'], ['dev', 'dev']]) {
    const line = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
    const sha = line.split(/\s+/)[0];
    if (!sha) {
      log(`note  origin has no ${branch} yet - nothing to fast-forward from; the push creates it`);
      continue;
    }
    if (!known(sha)) throw new Error(`origin/${branch} has commits this clone has never fetched - git fetch origin, then fast-forward ${local}`);
    if (!ancestor(sha, local)) throw new Error(`origin/${branch} has commits ${local} does not - fast-forward ${local} first`);
  }
  if (!ancestor('main', 'dev')) throw new Error('main is not an ancestor of dev - main takes releases only, so merge it into dev first');

  for (const [cmd, args] of checks) step(cmd, args);

  const files = bumped(root, version);
  for (const [rel] of files) log(`${dryRun ? 'would bump' : 'bump'}  ${rel} ${current} -> ${version}`);
  if (!dryRun) for (const [rel, text] of files) fs.writeFileSync(path.join(root, rel), text);

  step('git', ['add', '--', ...files.map(([rel]) => rel)]);
  step('git', ['commit', '-m', `release ${tag}`, '-m', TRAILER]);
  try {
    step('git', ['checkout', 'main']);
    step('git', ['merge', '--ff-only', 'dev']);
    step('git', ['tag', '-a', tag, '-m', `local-artifact ${version}`]);
    step('git', ['push', '--atomic', 'origin', 'main', 'dev', tag]);
  } finally {
    // Back on dev whatever happened, where the next piece of work belongs.
    if (!dryRun) {
      try { run('git', ['checkout', 'dev'], { cwd: root }); } catch {}
    }
    log(`${dryRun ? 'would run' : 'run'}  git checkout dev`);
  }
  log(dryRun ? `dry run - nothing changed; ${tag} would be released` : `released ${tag}`);
}

function main() {
  const args = process.argv.slice(2);
  // `npm run release 1.2.3 --dry-run` hands the flag to npm, not to us: npm reads --dry-run as
  // its own setting and passes it on only as npm_config_dry_run. Both spellings work.
  const dryRun = args.includes('--dry-run') || process.env.npm_config_dry_run === 'true';
  const rest = args.filter((a) => a !== '--dry-run');
  if (rest.length !== 1) {
    console.error('usage: npm run release <x.y.z> [--dry-run]');
    process.exit(2);
  }
  try {
    release({ version: rest[0], dryRun });
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
