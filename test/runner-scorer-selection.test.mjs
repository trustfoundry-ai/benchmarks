import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scorerAdapterId,
  validateScorerCutoffsMatchImplementation
} from '../src/core/runner.mjs';

test('scorerAdapterId defaults to search-recall when neither config sets it', () => {
  assert.equal(scorerAdapterId({}, {}), 'search-recall');
  assert.equal(scorerAdapterId(), 'search-recall');
});

test('scorerAdapterId reads benchmarkConfig.scorer with precedence over scorer config', () => {
  assert.equal(
    scorerAdapterId(
      { scorer: 'citation-lookup' },
      { id: 'search-recall' }
    ),
    'citation-lookup'
  );
  assert.equal(scorerAdapterId({}, { scorer: 'citation-lookup' }), 'citation-lookup');
  assert.equal(scorerAdapterId({}, { id: 'citation-lookup' }), 'citation-lookup');
});

test('scorerAdapterId accepts scorer_id/scorerId aliases on benchmark config', () => {
  assert.equal(scorerAdapterId({ scorer_id: 'citation-lookup' }, {}), 'citation-lookup');
  assert.equal(scorerAdapterId({ scorerId: 'citation-lookup' }, {}), 'citation-lookup');
});

test('validateScorerCutoffsMatchImplementation with citation-lookup constants accepts headline=1', () => {
  assert.doesNotThrow(() =>
    validateScorerCutoffsMatchImplementation(
      { cutoffs: [1, 5, 10, 25], headline_cutoff: 1 },
      { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'citation-lookup' }
    )
  );
});

test('validateScorerCutoffsMatchImplementation with citation-lookup constants rejects headline=25', () => {
  assert.throws(
    () =>
      validateScorerCutoffsMatchImplementation(
        { cutoffs: [1, 5, 10, 25], headline_cutoff: 25 },
        { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'citation-lookup' }
      ),
    /headline_cutoff 25 differs/
  );
});

test('validateScorerCutoffsMatchImplementation error references the passed scorerId in path', () => {
  try {
    validateScorerCutoffsMatchImplementation(
      { cutoffs: [1, 2, 3], headline_cutoff: 3 },
      { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'citation-lookup' }
    );
    assert.fail('expected throw');
  } catch (error) {
    assert.match(error.message, /citation-lookup\.mjs/);
  }
});

test('validateScorerCutoffsMatchImplementation defaults to search-recall constants when no override', () => {
  // search-recall's SUPPORTED_HEADLINE_CUTOFF is 25 — the default should accept it and reject 1.
  assert.doesNotThrow(() =>
    validateScorerCutoffsMatchImplementation({ cutoffs: [1, 5, 10, 25], headline_cutoff: 25 })
  );
  assert.throws(
    () => validateScorerCutoffsMatchImplementation({ cutoffs: [1, 5, 10, 25], headline_cutoff: 1 }),
    /headline_cutoff 1 differs/
  );
});
