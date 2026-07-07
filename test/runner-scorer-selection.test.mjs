import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scorerAdapterId,
  validateScorerCutoffsMatchImplementation
} from '../src/core/runner.mjs';

test('scorerAdapterId throws when neither config sets it (no framework default)', () => {
  assert.throws(() => scorerAdapterId({}, {}), /Scorer adapter id missing/);
  assert.throws(() => scorerAdapterId(), /Scorer adapter id missing/);
});

test('scorerAdapterId error names the registered scorer ids', () => {
  try {
    scorerAdapterId({}, {});
    assert.fail('expected throw');
  } catch (error) {
    assert.match(error.message, /Registered scorers:/);
  }
});

test('scorerAdapterId reads benchmarkConfig.scorer with precedence over scorer config', () => {
  assert.equal(
    scorerAdapterId(
      { scorer: 'rank1-headline-scorer' },
      { id: 'trustfoundry-legal-search' }
    ),
    'rank1-headline-scorer'
  );
  assert.equal(scorerAdapterId({}, { scorer: 'rank1-headline-scorer' }), 'rank1-headline-scorer');
  assert.equal(scorerAdapterId({}, { id: 'rank1-headline-scorer' }), 'rank1-headline-scorer');
});

test('scorerAdapterId accepts scorer_id/scorerId aliases on benchmark config', () => {
  assert.equal(scorerAdapterId({ scorer_id: 'rank1-headline-scorer' }, {}), 'rank1-headline-scorer');
  assert.equal(scorerAdapterId({ scorerId: 'rank1-headline-scorer' }, {}), 'rank1-headline-scorer');
});

test('validateScorerCutoffsMatchImplementation with headline=1 scorer constants accepts headline=1', () => {
  assert.doesNotThrow(() =>
    validateScorerCutoffsMatchImplementation(
      { cutoffs: [1, 5, 10, 25], headline_cutoff: 1 },
      { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'rank1-headline-scorer' }
    )
  );
});

test('validateScorerCutoffsMatchImplementation with headline=1 scorer constants rejects headline=25', () => {
  assert.throws(
    () =>
      validateScorerCutoffsMatchImplementation(
        { cutoffs: [1, 5, 10, 25], headline_cutoff: 25 },
        { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'rank1-headline-scorer' }
      ),
    /headline_cutoff 25 differs/
  );
});

test('validateScorerCutoffsMatchImplementation error references the passed scorerId in path', () => {
  try {
    validateScorerCutoffsMatchImplementation(
      { cutoffs: [1, 2, 3], headline_cutoff: 3 },
      { supportedCutoffs: [1, 5, 10, 25], supportedHeadlineCutoff: 1, scorerId: 'rank1-headline-scorer' }
    );
    assert.fail('expected throw');
  } catch (error) {
    assert.match(error.message, /rank1-headline-scorer\.mjs/);
  }
});

test('trustfoundry-legal-search scorer.validateConfig rejects a diverging headline cutoff', async () => {
  const { trustfoundryLegalSearchScorerAdapter } = await import(
    '../src/adapters/scorers/trustfoundry-legal-search.mjs'
  );
  assert.doesNotThrow(() =>
    trustfoundryLegalSearchScorerAdapter.validateConfig({
      scorerConfig: { cutoffs: [1, 5, 10, 25], headline_cutoff: 25 }
    })
  );
  assert.throws(
    () =>
      trustfoundryLegalSearchScorerAdapter.validateConfig({
        scorerConfig: { cutoffs: [1, 5, 10, 25], headline_cutoff: 1 }
      }),
    /headline_cutoff 1 differs/
  );
});
