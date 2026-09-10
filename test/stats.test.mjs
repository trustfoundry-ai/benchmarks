import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wilsonInterval } from '../src/core/stats.mjs';

test('wilsonInterval reproduces the published case-name headline interval', () => {
  // 8,850-row public bundle: pooled hit@1 0.9331 over 4,425 perturbed pairs.
  const [lo, hi] = wilsonInterval(Math.round(0.9331073446327683 * 4425), 4425);
  assert.ok(Math.abs(lo - 0.9253639752306297) < 1e-9, `lo ${lo}`);
  assert.ok(Math.abs(hi - 0.9400993549548526) < 1e-9, `hi ${hi}`);
});

test('an empty sample yields the full unit interval, not a confident zero', () => {
  assert.deepEqual(wilsonInterval(0, 0), [0, 1]);
});

test('the upper bound clamps to 1 exactly at a unanimous sample', () => {
  const [lo, hi] = wilsonInterval(264, 264);
  assert.equal(hi, 1);
  assert.equal(Number(lo.toFixed(4)), 0.9857);
});

test('wilsonInterval brackets the point estimate', () => {
  for (const [k, n] of [[1, 10], [5, 10], [9, 10], [295, 295], [0, 295]]) {
    const [lo, hi] = wilsonInterval(k, n);
    assert.ok(lo <= k / n && k / n <= hi, `${k}/${n} not bracketed by [${lo}, ${hi}]`);
    assert.ok(lo >= 0 && hi <= 1, `${k}/${n} interval out of [0,1]`);
  }
});
