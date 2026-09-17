import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame } from '../lib/sse.mjs';

// Written as escapes on purpose: raw U+2028/U+2029 are invisible, and a test nobody can read is
// a test that quietly rots into one that passes on anything.
const LS = '\u2028';
const PS = '\u2029';

const comment = (payload) => `event: comment\ndata: ${JSON.stringify(payload)}`;

test('a payload carrying U+2028/U+2029 survives the round trip', () => {
  // These are line terminators to a JS regex, and JSON.stringify leaves them raw - which is the
  // whole bug, so pin that premise before asserting anything about the parse.
  const payload = { seq: 1, comment: `line${LS}break${PS}here`, anchor: { selectedText: `a${LS}b` } };
  const frame = comment(payload);
  assert.ok(frame.includes(LS) && frame.includes(PS));

  const { event, data } = parseFrame(frame);
  assert.equal(event, 'comment');
  assert.deepEqual(JSON.parse(data), payload);
});

test('an event: line inside the comment text does not become the event', () => {
  // U+2028 around it makes ` event: hello ` a whole line to /^event: hello$/m.
  const frame = comment({ seq: 2, comment: `why does${LS}event: hello${LS}show up` });
  const { event, data } = parseFrame(frame);
  assert.equal(event, 'comment');
  assert.equal(JSON.parse(data).seq, 2);
});

test('reads a hello frame', () => {
  const { event, data } = parseFrame('event: hello\ndata: {"instance":"abc"}');
  assert.equal(event, 'hello');
  assert.equal(JSON.parse(data).instance, 'abc');
});

test('a ping or any comment-only frame has no data', () => {
  assert.equal(parseFrame(': ping').data, undefined);
  assert.equal(parseFrame(': ping').event, undefined);
  assert.equal(parseFrame('event: comment').data, undefined);
});

test('tolerates CRLF', () => {
  const { event, data } = parseFrame('event: comment\r\ndata: {"seq":3}\r');
  assert.equal(event, 'comment');
  assert.equal(JSON.parse(data).seq, 3);
});

test('joins multiple data lines with a newline', () => {
  assert.equal(parseFrame('event: x\ndata: a\ndata: b').data, 'a\nb');
});
