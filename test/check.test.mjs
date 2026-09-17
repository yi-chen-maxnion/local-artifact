import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { at, scan } from '../scripts/check.mjs';

/**
 * Every forbidden character in here is built from its number and never typed, because a tool that
 * quietly turns an escape into the character it stands for is the thing being guarded against -
 * it must not be able to rewrite the guard. That also keeps this file text: `file` must not call
 * it data, or the scan it is testing would have skipped it.
 */
const ch = (code) => String.fromCharCode(code);

describe('the control character scan', () => {
  test('finds every character that turns a source file into a binary blob', () => {
    const codes = [
      0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, // C0, CR and DEL
      0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, // zero-width and invisible
      0x2028, 0x2029, // a line to JavaScript, nothing to anything else
    ];
    for (const code of codes) {
      const found = scan(`a${ch(code)}b`, 'x.mjs');
      assert.deepEqual(found.map((o) => o.code), [code], `U+${code.toString(16)} is caught`);
    }
  });

  test('leaves what source is legitimately written with alone', () => {
    // A tab, a newline, and the non-ASCII this repo really contains: Chinese UI strings, the
    // ellipsis and middle dot the panel uses, an em dash, an emoji from a notification.
    const ok = `中文 a${ch(0x09)}b…c·d—e🔗${ch(0x0a)}${ch(0x09)}中文${ch(0x0a)}`;
    assert.deepEqual(scan(ok, 'x.mjs'), []);
  });

  test('says where, so the fix is one jump away', () => {
    const buf = Buffer.from(`ok\nalso ok\nbad ${ch(0x07)}here\n`);
    assert.deepEqual(scan(buf, 'bridge/x.mjs').map(at), ['bridge/x.mjs:3:5 U+0007']);
  });

  test('counts columns in characters, and a mark at the very start still counts', () => {
    // An emoji is one column, not two: the column is the one an editor would put the cursor in.
    assert.deepEqual(scan(`🔗${ch(0x200b)}`, 'f').map(at), ['f:1:2 U+200B']);
    assert.deepEqual(scan(`${ch(0xfeff)}import fs`, 'f').map(at), ['f:1:1 U+FEFF']);
  });

  test('reads a buffer and a string the same way', () => {
    const line = `a${ch(0x01)}b`;
    assert.deepEqual(scan(Buffer.from(line), 'f').map(at), scan(line, 'f').map(at));
  });
});
