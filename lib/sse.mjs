/**
 * Reading one SSE frame, by hand, because a regex cannot.
 *
 * `.` in JS does not match U+2028/U+2029 but `JSON.stringify` emits them raw, so
 * `/^data: (.*)$/m` cuts the payload off at the first one - and text copied out of a PDF or a
 * word processor carries them. The parse then throws and the comment is simply gone, after the
 * bridge answered 200 and the page drew its pin. `^`/`$` under /m match at those characters
 * too, so page data could even pass for an `event:` line. Splitting on "\n" is the whole fix.
 */

/**
 * One frame (the text before the blank line that ended it) -> `{ event, data }`, both raw.
 * `data` is undefined when the frame carries no `data:` field at all - a `: ping` or any other
 * comment line - which is the caller's signal to skip it.
 */
export function parseFrame(frame) {
  let event;
  const data = [];
  for (let line of String(frame).split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1); // a CRLF stream is still legal SSE
    if (line.startsWith('data: ')) data.push(line.slice(6));
    else if (line.startsWith('event: ')) event = line.slice(7);
  }
  // Several data lines are one value joined by newlines, per the spec. The bridge never sends
  // them; honouring it costs a join.
  return { event, data: data.length ? data.join('\n') : undefined };
}
