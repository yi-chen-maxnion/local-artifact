#!/usr/bin/env node
/**
 * What `npm run check` runs: every source file parses, and no source file holds a raw control or
 * invisible character.
 *
 * The second half is here because of what one such byte does to everything else. A literal NUL
 * inside a regex class and a literal 0x01 in a test were both perfectly functional, and both made
 * their file binary to every tool that touches this repo: `grep -r` skipped it without a word,
 * `git diff` printed "Binary files differ", and a repo-wide search for a function came back empty
 * from the file that defines it. The escape is the same character to the program and a readable
 * one to everything else, so the escape is what belongs in the source. Zero-width and
 * line-separator characters are the other half of the same trouble - not binary, merely invisible,
 * so a test that means to hold one has to say so out loud.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** Where the source is, and what counts as some. README is the only file that stands alone. */
const SOURCES = [
  ['lib', /\.mjs$/],
  ['bridge', /\.mjs$/],
  ['scripts', /\.mjs$/],
  ['test', /\.mjs$/],
  ['extension', /\.(js|html)$/],
  ['commands', /\.md$/],
  ['docs', /\.md$/],
  ['.', /^README\.md$/],
];

/**
 * TAB and LF are the only control characters anything here is written with - no file in the repo
 * has ever carried a CR, so a stray one is news as well. Above them sit the characters that are
 * not binary but are just as unreadable: DEL, the zero-width range, the word joiner, the byte
 * order mark, and the two separators that end a line for JavaScript and for nothing else.
 *
 * Every one of them is written as a number rather than as an escape, because this file is one of
 * the files being scanned and the escapes are exactly what tools have been seen to decode.
 */
const forbidden = (c) => (c < 0x20 && c !== 0x09 && c !== 0x0a)
  || c === 0x7f
  || c === 0x2028 || c === 0x2029
  || c === 0x2060 || c === 0xfeff
  || (c >= 0x200b && c <= 0x200f);

const hex = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;

/** An offender, as somewhere to jump to: `path:line:col U+XXXX`. */
export const at = (o) => `${o.file}:${o.line}:${o.col} ${hex(o.code)}`;

/** Counted in characters rather than bytes, so the column is the one an editor shows. */
export function scan(input, file = '') {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const out = [];
  let line = 1;
  let col = 1;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0x0a) { line++; col = 1; continue; }
    if (forbidden(code)) out.push({ file, line, col, code });
    col++;
  }
  return out;
}

export function sources() {
  const out = [];
  for (const [dir, re] of SOURCES) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (re.test(name)) out.push(dir === '.' ? name : `${dir}/${name}`);
    }
  }
  return out;
}

function main() {
  const bad = [];
  for (const rel of sources()) {
    if (/\.(mjs|js)$/.test(rel)) {
      try {
        // Relative, from the root: node's own syntax error is the message, and it names the file.
        execFileSync(process.execPath, ['--check', rel], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
      } catch {
        process.exit(1);
      }
    }
    bad.push(...scan(fs.readFileSync(path.join(ROOT, rel)), rel));
  }
  if (bad.length) {
    for (const o of bad) console.error(at(o));
    console.error(`${bad.length} raw control or invisible character(s) - write the escape instead`);
    process.exit(1);
  }
  // The line other tooling greps for. It now covers more than parsing, and still says this.
  console.log('all files parse');
}

// Importable for the scanner alone: nothing runs unless this file is what was started.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
