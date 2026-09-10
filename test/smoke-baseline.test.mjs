import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  baselineFrom,
  compareToBaseline,
  formatChangedRow,
  formatSummaryLine,
  parseArgs
} from '../scripts/check-smoke-baseline.mjs';

const baseline = {
  target: 'trustfoundry-case-name-lookup/public-1050',
  rows: { c1: { hit: true, rank: 1, category: 'party_misspell', arm: 'perturbed' } }
};

test('an identical run passes', () => {
  const res = compareToBaseline({
    baseline,
    scores: { caseScores: [{ caseId: 'c1', hitAt1: true, hitRank: 1, nameTransform: 'party_misspell', arm: 'perturbed' }] }
  });
  assert.equal(res.ok, true);
  assert.equal(res.changed.length, 0);
  assert.equal(res.total, 1);
});

test('a flipped row is reported with its category, arm, and kind', () => {
  const res = compareToBaseline({
    baseline,
    scores: { caseScores: [{ caseId: 'c1', hitAt1: false, hitRank: null, nameTransform: 'party_misspell', arm: 'perturbed' }] },
    allowedChanges: 0
  });
  assert.equal(res.ok, false);
  assert.equal(res.changed[0].category, 'party_misspell');
  assert.equal(res.changed[0].arm, 'perturbed');
  assert.equal(res.changed[0].kind, 'flipped');
  assert.equal(res.changed[0].was, true);
  assert.equal(res.changed[0].now, false);
  assert.equal(res.changed[0].wasRank, 1);
  assert.equal(res.changed[0].nowRank, null);
});

test('changes within the allowance still pass but are reported', () => {
  const res = compareToBaseline({
    baseline,
    scores: { caseScores: [{ caseId: 'c1', hitAt1: false, hitRank: null, nameTransform: 'party_misspell', arm: 'perturbed' }] },
    allowedChanges: 5
  });
  assert.equal(res.ok, true);
  assert.equal(res.changed.length, 1);
});

test('a missing row is a change, not a silent pass', () => {
  const res = compareToBaseline({ baseline, scores: { caseScores: [] }, allowedChanges: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.changed[0].kind, 'missing');
  assert.equal(res.changed[0].was, true);
  assert.equal(res.changed[0].now, 'missing from run');
});

test('a row present in the run but absent from the baseline is reported as unexpected', () => {
  const res = compareToBaseline({
    baseline,
    scores: {
      caseScores: [
        { caseId: 'c1', hitAt1: true, hitRank: 1, nameTransform: 'party_misspell', arm: 'perturbed' },
        { caseId: 'c2', hitAt1: true, hitRank: 2, nameTransform: 'given_name', arm: 'natural' }
      ]
    },
    allowedChanges: 0
  });
  assert.equal(res.ok, false);
  assert.equal(res.changed.length, 1);
  assert.equal(res.changed[0].caseId, 'c2');
  assert.equal(res.changed[0].kind, 'unexpected');
  assert.equal(res.changed[0].category, 'given_name');
  assert.equal(res.changed[0].arm, 'natural');
  assert.equal(res.changed[0].was, 'absent from baseline');
  assert.equal(res.changed[0].now, true);
});

test('a rank-only change with the same hit is still flagged as flipped', () => {
  const res = compareToBaseline({
    baseline,
    scores: { caseScores: [{ caseId: 'c1', hitAt1: true, hitRank: 2, nameTransform: 'party_misspell', arm: 'perturbed' }] },
    allowedChanges: 0
  });
  assert.equal(res.ok, false);
  assert.equal(res.changed[0].kind, 'flipped');
  assert.equal(res.changed[0].wasRank, 1);
  assert.equal(res.changed[0].nowRank, 2);
});

test('the default allowance is 5: five changed rows out of many still pass, a sixth does not', () => {
  const bigBaseline = { target: 'x', rows: {} };
  for (let i = 0; i < 20; i += 1) {
    bigBaseline.rows[`c${i}`] = { hit: true, rank: 1, category: 'party_misspell', arm: 'perturbed' };
  }
  const flip = (n) =>
    Array.from({ length: 20 }, (_, i) => ({
      caseId: `c${i}`,
      hitAt1: i < n ? false : true,
      hitRank: i < n ? null : 1,
      nameTransform: 'party_misspell',
      arm: 'perturbed'
    }));

  const five = compareToBaseline({ baseline: bigBaseline, scores: { caseScores: flip(5) } });
  assert.equal(five.ok, true);
  assert.equal(five.changed.length, 5);

  const six = compareToBaseline({ baseline: bigBaseline, scores: { caseScores: flip(6) } });
  assert.equal(six.ok, false);
  assert.equal(six.changed.length, 6);
});

test('formatSummaryLine counts unchanged from the baseline side only, reporting an unexpected row separately rather than folding it into the subtraction', () => {
  const res = compareToBaseline({
    baseline,
    scores: {
      caseScores: [
        { caseId: 'c1', hitAt1: true, hitRank: 1, nameTransform: 'party_misspell', arm: 'perturbed' },
        { caseId: 'c4', hitAt1: true, hitRank: 1, nameTransform: 'given_name', arm: 'natural' }
      ]
    }
  });
  // c1 (the only baseline row) is unchanged; c4 is unexpected. A line that
  // subtracted changed.length (1, for c4) from total (1, for c1) would
  // wrongly report "0/1 baseline rows unchanged", asserting a baseline flip
  // that never happened.
  assert.equal(
    formatSummaryLine({ total: res.total, changed: res.changed, allowedChanges: 5 }),
    'smoke baseline: 1/1 baseline rows unchanged, 0 changed, 1 unexpected (allowance 5)'
  );
});

test('formatChangedRow prints the rank detail for a rank-only change, distinguishing it from a verdict flip', () => {
  const res = compareToBaseline({
    baseline,
    scores: { caseScores: [{ caseId: 'c1', hitAt1: true, hitRank: 3, nameTransform: 'party_misspell', arm: 'perturbed' }] },
    allowedChanges: 0
  });
  assert.equal(res.changed[0].kind, 'flipped');
  assert.equal(res.changed[0].was, res.changed[0].now); // hit did not change
  assert.equal(
    formatChangedRow(res.changed[0]),
    '  c1  party_misspell/perturbed  true -> true  (rank 1 -> 3)'
  );
});

test('formatChangedRow omits the rank suffix when a flipped row has no rank change', () => {
  const res = compareToBaseline({
    baseline,
    scores: { caseScores: [{ caseId: 'c1', hitAt1: false, hitRank: 1, nameTransform: 'party_misspell', arm: 'perturbed' }] },
    allowedChanges: 0
  });
  assert.equal(res.changed[0].kind, 'flipped');
  assert.equal(
    formatChangedRow(res.changed[0]),
    '  c1  party_misspell/perturbed  true -> false'
  );
});

test('formatChangedRow renders missing and unexpected rows without a rank suffix', () => {
  const missing = compareToBaseline({ baseline, scores: { caseScores: [] }, allowedChanges: 0 });
  assert.equal(formatChangedRow(missing.changed[0]), '  c1  party_misspell/perturbed  true -> missing from run');

  const unexpected = compareToBaseline({
    baseline,
    scores: {
      caseScores: [
        { caseId: 'c1', hitAt1: true, hitRank: 1, nameTransform: 'party_misspell', arm: 'perturbed' },
        { caseId: 'c4', hitAt1: true, hitRank: 1, nameTransform: 'given_name', arm: 'natural' }
      ]
    },
    allowedChanges: 0
  });
  const c4 = unexpected.changed.find((row) => row.caseId === 'c4');
  assert.equal(formatChangedRow(c4), '  c4  given_name/natural  absent from baseline -> true');
});

test('baselineFrom keys rows by caseId and carries hit, rank, category, and arm', () => {
  const result = baselineFrom({
    target: 'trustfoundry-case-name-lookup/public-1050',
    scores: {
      caseScores: [
        { caseId: 'c1', hitAt1: true, hitRank: 1, nameTransform: 'party_misspell', arm: 'perturbed' },
        { caseId: 'c2', hitAt1: false, hitRank: null, nameTransform: 'given_name', arm: 'natural' }
      ]
    }
  });
  assert.equal(result.target, 'trustfoundry-case-name-lookup/public-1050');
  assert.deepEqual(result.rows, {
    c1: { hit: true, rank: 1, category: 'party_misspell', arm: 'perturbed' },
    c2: { hit: false, rank: null, category: 'given_name', arm: 'natural' }
  });
});

test('baselineFrom tolerates a missing caseScores array', () => {
  const result = baselineFrom({ target: 't', scores: {} });
  assert.deepEqual(result, { target: 't', rows: {} });
});

test('parseArgs accepts the happy path: --run, --allow, and --write together', () => {
  assert.deepEqual(parseArgs(['--run', 'runs/latest', '--allow', '3', '--write']), {
    runDir: 'runs/latest',
    allowedChanges: 3,
    write: true
  });
});

test('parseArgs defaults --allow to 5 and --write to false', () => {
  assert.deepEqual(parseArgs(['--run', 'runs/latest']), {
    runDir: 'runs/latest',
    allowedChanges: 5,
    write: false
  });
});

test('parseArgs accepts --write at the start, middle, or end', () => {
  const expected = { runDir: 'runs/latest', allowedChanges: 5, write: true };
  assert.deepEqual(parseArgs(['--write', '--run', 'runs/latest']), expected);
  assert.deepEqual(parseArgs(['--run', 'runs/latest', '--write']), expected);
  assert.deepEqual(
    parseArgs(['--run', 'runs/latest', '--write', '--allow', '5']),
    { runDir: 'runs/latest', allowedChanges: 5, write: true }
  );
});

test('parseArgs rejects a flag-shaped token where --run expects a value', () => {
  assert.throws(() => parseArgs(['--run', '--allow', '3']), /--run requires a value/);
});

test('parseArgs rejects --run with no value at end of argv', () => {
  assert.throws(() => parseArgs(['--run']), /--run requires a value/);
});

test('parseArgs rejects a flag-shaped token where --allow expects a value', () => {
  assert.throws(() => parseArgs(['--run', 'runs/latest', '--allow', '--write']), /--allow requires a value/);
});

test('parseArgs rejects a non-integer --allow value', () => {
  assert.throws(() => parseArgs(['--run', 'runs/latest', '--allow', 'abc']), /--allow requires a non-negative integer/);
});

test('parseArgs rejects a negative --allow value', () => {
  assert.throws(() => parseArgs(['--run', 'runs/latest', '--allow', '-1']), /--allow requires a value|non-negative integer/);
});

test('parseArgs rejects a repeated --run rather than silently keeping the first', () => {
  assert.throws(
    () => parseArgs(['--run', 'runs/a', '--run', 'runs/b']),
    /--run given more than once/
  );
});

test('parseArgs rejects a repeated --allow rather than silently keeping the first', () => {
  assert.throws(
    () => parseArgs(['--run', 'runs/a', '--allow', '1', '--allow', '2']),
    /--allow given more than once/
  );
});

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--run', 'runs/a', '--bogus']), /unknown flag: --bogus/);
});

test('parseArgs rejects a stray positional argument', () => {
  assert.throws(() => parseArgs(['--run', 'runs/a', 'extra']), /unexpected argument: extra/);
});

test('parseArgs rejects a missing --run', () => {
  assert.throws(() => parseArgs(['--allow', '3']), /missing required --run/);
});
