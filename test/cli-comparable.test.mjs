import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareInputs } from '../src/core/comparable.mjs';

const base = {
  benchmark: { configSha256: 'a', sourceFiles: [{ path: 'd.jsonl', sha256: 'd1' }] },
  scorer: { configSha256: 's', version: 'v1' }
};

test('identical inputs are comparable', () => {
  assert.equal(compareInputs(base, structuredClone(base)).comparable, true);
});

test('a differing dataset digest is reported', () => {
  const other = structuredClone(base);
  other.benchmark.sourceFiles[0].sha256 = 'd2';
  const res = compareInputs(base, other);
  assert.equal(res.comparable, false);
  assert.ok(res.differences.some((d) => d.field === 'dataset:d.jsonl'));
});

test('a differing scorer version is reported', () => {
  const other = structuredClone(base);
  other.scorer.version = 'v2';
  assert.ok(compareInputs(base, other).differences.some((d) => d.field === 'scorer.version'));
});

test('a field both inputs omit is reported as a difference, not agreement', () => {
  const left = structuredClone(base);
  const right = structuredClone(base);
  delete left.scorer.version;
  delete right.scorer.version;
  const res = compareInputs(left, right);
  assert.equal(res.comparable, false);
  const diff = res.differences.find((d) => d.field === 'scorer.version');
  assert.ok(diff, 'expected scorer.version to be named as a difference');
  assert.equal(diff.a, null);
  assert.equal(diff.b, null);
});
