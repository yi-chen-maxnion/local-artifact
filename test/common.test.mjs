import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimiter } from '../lib/common.mjs';

/** A clock the test moves by hand, so nothing here waits out a real window. */
function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

describe('rateLimiter', () => {
  test('allows max in a window and refuses the rest', () => {
    const c = clock();
    const allow = rateLimiter(3, 1000, c.now);
    assert.deepEqual([allow(), allow(), allow()], [true, true, true]);
    assert.equal(allow(), false);
    c.tick(999);
    assert.equal(allow(), false);
    c.tick(1); // the first three are now a full window old
    assert.equal(allow(), true);
  });

  test('a refusal is not counted, so hammering cannot hold the window shut', () => {
    const c = clock();
    const allow = rateLimiter(1, 1000, c.now);
    assert.equal(allow(), true);
    c.tick(500);
    for (let i = 0; i < 50; i++) assert.equal(allow(), false);
    // If those refusals had been stamped, the window would still be closed here.
    c.tick(500);
    assert.equal(allow(), true);
  });

  test('the window slides rather than resetting in blocks', () => {
    const c = clock();
    const allow = rateLimiter(2, 1000, c.now);
    assert.equal(allow(), true); // t
    c.tick(600);
    assert.equal(allow(), true); // t+600
    c.tick(300);
    assert.equal(allow(), false); // t+900: both still inside the window
    c.tick(100);
    assert.equal(allow(), true); // t+1000: the first one has aged out, the second has not
    assert.equal(allow(), false);
  });
});
