import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultRetryFilter } from '../src/core/retry.mjs';

test('defaultRetryFilter reissues cases with non-completed status', () => {
  const shouldRetry = defaultRetryFilter({
    providerResult: { status: 'provider_failure' },
    caseScore: { score: 0 }
  });
  assert.equal(shouldRetry, true);
});

test('defaultRetryFilter reissues cases that scored less than 1.0', () => {
  const shouldRetry = defaultRetryFilter({
    providerResult: { status: 'completed' },
    caseScore: { score: 0.5 }
  });
  assert.equal(shouldRetry, true);
});

test('defaultRetryFilter leaves completed cases with score 1.0 alone', () => {
  const shouldRetry = defaultRetryFilter({
    providerResult: { status: 'completed' },
    caseScore: { score: 1.0 }
  });
  assert.equal(shouldRetry, false);
});

test('defaultRetryFilter treats missing providerResult as retryable', () => {
  const shouldRetry = defaultRetryFilter({
    providerResult: null,
    caseScore: null
  });
  assert.equal(shouldRetry, true);
});

test('defaultRetryFilter treats missing caseScore as non-retryable if completed', () => {
  const shouldRetry = defaultRetryFilter({
    providerResult: { status: 'completed' },
    caseScore: null
  });
  assert.equal(shouldRetry, false);
});
