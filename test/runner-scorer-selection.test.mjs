import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scorerAdapterId,
  validateScorerCutoffsMatchImplementation
} from '../src/core/runner.mjs';

test('scorerAdapterId defaults to trustfoundry-legal-search when neither config sets it', () => {
  assert.equal(scorerAdapterId({}, {}), 'trustfoundry-legal-search');
  assert.equal(scorerAdapterId(), 'trustfoundry-legal-search');
});

test('scorerAdapterId reads benchmarkConfig.scorer with precedence over scorer config', () => {
  assert.equal(
    scorerAdapterId(
      { scorer: 'trustfoundry-citation-lookup' },
      { id: 'trustfoundry-legal-search' }
    ),
    'trustfoundry-citation-lookup'
  );
  assert.equal(scorerAdapterId({}, { scorer: 'trustfoundry-citation-lookup' }), 'trustfoundry-citation-lookup');
  assert.equal(scorerAdapterId({}, { id: 'trustfoundry-citation-lookup' }), 'trustfoundry-citation-lookup');
});

test('scorerAdapterId accepts scorer_id/scorerId aliases on benchmark config', () => {
  assert.equal(scorerAdapterId({ scorer_id: 'trustfoundry-citation-lookup' }, {}), 'trustfoundry-citation-lookup');
  assert.equal(scorerAdapterId({ scorerId: 'trustfoundry-citation-lookup' }, {}), 'trustfoundry-citation-lookup');
});

test('validateScorerCutoffsMatchImplementation with citation-lookup constants accepts headline=1', () => {
  assert.doesNotThrow(() =>
    validateScorerCutoffsMatchImplementation(
      { cutoffs: [1, 5, 10, 25], headline_cutoff: 1 },
      { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'trustfoundry-citation-lookup' }
    )
  );
});

test('validateScorerCutoffsMatchImplementation with citation-lookup constants rejects headline=25', () => {
  assert.throws(
    () =>
      validateScorerCutoffsMatchImplementation(
        { cutoffs: [1, 5, 10, 25], headline_cutoff: 25 },
        { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'trustfoundry-citation-lookup' }
      ),
    /headline_cutoff 25 differs/
  );
});

test('validateScorerCutoffsMatchImplementation error references the passed scorerId in path', () => {
  try {
    validateScorerCutoffsMatchImplementation(
      { cutoffs: [1, 2, 3], headline_cutoff: 3 },
      { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'trustfoundry-citation-lookup' }
    );
    assert.fail('expected throw');
  } catch (error) {
    assert.match(error.message, /citation-lookup\.mjs/);
  }
});

test('validateScorerCutoffsMatchImplementation defaults to trustfoundry-legal-search constants when no override', () => {
  // trustfoundry-legal-search's SUPPORTED_HEADLINE_CUTOFF is 25 — the default should accept it and reject 1.
  assert.doesNotThrow(() =>
    validateScorerCutoffsMatchImplementation({ cutoffs: [1, 5, 10, 25], headline_cutoff: 25 })
  );
  assert.throws(
    () => validateScorerCutoffsMatchImplementation({ cutoffs: [1, 5, 10, 25], headline_cutoff: 1 }),
    /headline_cutoff 1 differs/
  );
});
