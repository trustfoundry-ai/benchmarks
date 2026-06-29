import assert from 'node:assert/strict';
import test from 'node:test';

import {
  maxScorerCutoff,
  readApiRequestLimit,
  validateApiRequestLimitAgainstCutoffs,
  validateScorerCutoffsMatchImplementation
} from '../src/core/runner.mjs';

test('maxScorerCutoff returns max of cutoffs and headline_cutoff', () => {
  assert.equal(
    maxScorerCutoff({ cutoffs: [1, 5, 10, 25], headline_cutoff: 25 }),
    25
  );
  assert.equal(
    maxScorerCutoff({ cutoffs: [1, 5, 10], headline_cutoff: 100 }),
    100
  );
  assert.equal(
    maxScorerCutoff({ cutoffs: [1, 5, 10, 50], headline_cutoff: 25 }),
    50
  );
});

test('maxScorerCutoff returns null when no cutoffs or headline are present', () => {
  assert.equal(maxScorerCutoff({}), null);
  assert.equal(maxScorerCutoff({ cutoffs: [] }), null);
});

test('readApiRequestLimit returns the configured positive integer', () => {
  assert.equal(readApiRequestLimit({ api_request_limit: 25 }), 25);
  assert.equal(readApiRequestLimit({ apiRequestLimit: 10 }), 10);
});

test('readApiRequestLimit returns null when unset', () => {
  assert.equal(readApiRequestLimit({}), null);
});

test('readApiRequestLimit throws on invalid values', () => {
  for (const bad of [0, -3, 'twenty']) {
    assert.throws(
      () => readApiRequestLimit({ api_request_limit: bad }),
      /Invalid api_request_limit/
    );
  }
});

test('validateApiRequestLimitAgainstCutoffs passes when limit >= max cutoff', () => {
  const result = validateApiRequestLimitAgainstCutoffs({
    api_request_limit: 25,
    cutoffs: [1, 5, 10, 25],
    headline_cutoff: 25
  });
  assert.deepEqual(result, { apiRequestLimit: 25, maxCutoff: 25 });
});

test('validateApiRequestLimitAgainstCutoffs accepts limit greater than max cutoff', () => {
  const result = validateApiRequestLimitAgainstCutoffs({
    api_request_limit: 50,
    cutoffs: [1, 5, 10, 25],
    headline_cutoff: 25
  });
  assert.equal(result.apiRequestLimit, 50);
  assert.equal(result.maxCutoff, 25);
});

test('validateApiRequestLimitAgainstCutoffs throws when limit < max cutoff', () => {
  assert.throws(
    () =>
      validateApiRequestLimitAgainstCutoffs({
        api_request_limit: 25,
        cutoffs: [1, 5, 10, 25, 100],
        headline_cutoff: 100
      }),
    /api_request_limit \(25\) < .* \(100\)/
  );
});

test('validateApiRequestLimitAgainstCutoffs error message references the public-api cap', () => {
  try {
    validateApiRequestLimitAgainstCutoffs({
      api_request_limit: 10,
      cutoffs: [1, 5, 25],
      headline_cutoff: 25
    });
    assert.fail('expected throw');
  } catch (error) {
    assert.match(error.message, /api\.trustfoundry\.ai/);
  }
});

test('validateApiRequestLimitAgainstCutoffs is a no-op when neither side is set', () => {
  const result = validateApiRequestLimitAgainstCutoffs({});
  assert.deepEqual(result, { apiRequestLimit: null, maxCutoff: null });
});

test('validateScorerCutoffsMatchImplementation accepts the implementation defaults', () => {
  assert.doesNotThrow(() =>
    validateScorerCutoffsMatchImplementation({
      cutoffs: [1, 5, 10, 25],
      headline_cutoff: 25
    })
  );
});

test('validateScorerCutoffsMatchImplementation accepts cutoffs in any order', () => {
  assert.doesNotThrow(() =>
    validateScorerCutoffsMatchImplementation({
      cutoffs: [25, 1, 10, 5],
      headline_cutoff: 25
    })
  );
});

test('validateScorerCutoffsMatchImplementation throws when cutoffs diverge', () => {
  assert.throws(
    () =>
      validateScorerCutoffsMatchImplementation({
        cutoffs: [1, 5, 10, 100],
        headline_cutoff: 100
      }),
    /cutoffs .* differs from the scorer's implementation/
  );
});

test('validateScorerCutoffsMatchImplementation throws when headline_cutoff diverges', () => {
  assert.throws(
    () =>
      validateScorerCutoffsMatchImplementation({
        cutoffs: [1, 5, 10, 25],
        headline_cutoff: 50
      }),
    /headline_cutoff 50 differs/
  );
});

test('validateScorerCutoffsMatchImplementation is a no-op when neither field is set', () => {
  assert.doesNotThrow(() => validateScorerCutoffsMatchImplementation({}));
});
