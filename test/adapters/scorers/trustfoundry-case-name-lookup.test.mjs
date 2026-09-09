import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  caseNameLookupScorerAdapter,
  SUPPORTED_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF,
  _internals
} from '../../../src/adapters/scorers/trustfoundry-case-name-lookup.mjs';
import { caseNameLookupBenchmarkAdapter } from '../../../src/adapters/benchmarks/trustfoundry-case-name-lookup.mjs';
import { buildRawRows } from '../../../src/core/artifacts.mjs';
import { readJson } from '../../../src/core/fs.mjs';
const { captionHitRank } = _internals;

function mkCase(caseId, expected) {
  return {
    caseId,
    benchmarkId: 'trustfoundry-case-name-lookup',
    prompt: 'q',
    metadata: {
      tier: expected.tier ?? null,
      // A positive row always carries a real transform in valid data (see
      // `buildAxisSummary`); fixtures that don't care which one default to
      // 'clean' rather than null so they don't exercise that guard by
      // accident.
      name_transform: expected.name_transform ?? 'clean',
      negative_category: expected.negative_category ?? null,
      datasetIndex: 0,
      expected: { ...expected }
    },
    scoringHints: {
      kind: 'trustfoundry-case-name-lookup',
      outputMode: 'json',
      negative: expected.kind === 'negative'
    }
  };
}

// `entries` is an array of { citation, title } (either may be omitted).
function mkResult(caseId, entries, { status = 'completed', durationMs = 100 } = {}) {
  const results = entries.map((e, i) => ({
    rank: i + 1,
    citation: e.citation ?? null,
    citations: e.citation ? [e.citation] : [],
    title: e.title ?? null,
    header: e.title ?? null,
    document_uuid: null
  }));
  return {
    caseId,
    status,
    finalOutputText: JSON.stringify({ query: 'q', result_count: results.length, results }),
    timing: { durationMs }
  };
}

async function scoreOne(benchmarkCase, providerResult, config = {}) {
  return caseNameLookupScorerAdapter.score({
    manifest: null,
    cases: [benchmarkCase],
    providerResults: [providerResult],
    config
  });
}

// Describes one negative-tier row for the `negatives_overall.by_category`
// breakdown tests below: which category it carries, and whether the
// provider returned a result (a false positive) or nothing (correct).
let negativeCaseSeq = 0;
function negativeCase({ negativeCategory = null, falsePositive = false } = {}) {
  return { caseId: `neg-${negativeCaseSeq++}`, negativeCategory, falsePositive };
}

// Runs a batch of negativeCase() specs through the real scorer pipeline and
// returns the resulting summary -- exercising aggregateNegatives exactly as
// buildSummary calls it, not as an isolated unit.
async function buildSummaryForCases(specs) {
  const cases = specs.map((spec) =>
    mkCase(spec.caseId, {
      kind: 'negative',
      tier: 'negatives',
      negative_category: spec.negativeCategory,
      gold_citations: []
    })
  );
  const providerResults = specs.map((spec) =>
    mkResult(spec.caseId, spec.falsePositive ? [{ citation: 'anything' }] : [])
  );
  const out = await caseNameLookupScorerAdapter.score({
    manifest: null,
    cases,
    providerResults,
    config: {}
  });
  return out.summary;
}

test('1. qualified positive, gold at rank 1 -> score 1, hitAt1 true, reciprocalRank 1', async () => {
  const bc = mkCase('c1', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Searoad v. Dupont',
    gold_citations: [{ canonical_citation: '361 F.2d 833', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('c1', [{ citation: '361 F.2d 833', title: 'Searoad v. Dupont' }]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.score, 1);
  assert.equal(cs.hitAt1, true);
  assert.equal(cs.reciprocalRank, 1);
});

test('2. gold at rank 2 -> score 0, hitRank 2, hitAt1 false, hitAt3/hitAt5 true, reciprocalRank 0.5', async () => {
  const bc = mkCase('c2', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Searoad v. Dupont',
    gold_citations: [{ canonical_citation: '361 F.2d 833', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('c2', [
    { citation: 'not-gold' },
    { citation: '361 F.2d 833', title: 'Searoad v. Dupont' }
  ]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  // The headline question is "did the top result carry the wanted case's
  // name", so rank 2 misses the headline even though it still counts for
  // hit@3/hit@5.
  assert.equal(cs.score, 0);
  assert.equal(cs.hitRank, 2);
  assert.equal(cs.hitAt1, false);
  assert.equal(cs.hitAt3, true);
  assert.equal(cs.hitAt5, true);
  assert.equal(cs.reciprocalRank, 0.5);
});

test('3. miss -> hitRank null, reciprocalRank 0, score 0', async () => {
  const bc = mkCase('c3', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Searoad v. Dupont',
    gold_citations: [{ canonical_citation: '361 F.2d 833', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('c3', [{ citation: 'not-gold-1' }, { citation: 'not-gold-2' }]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, null);
  assert.equal(cs.reciprocalRank, 0);
  assert.equal(cs.score, 0);
});

test('8. negative row -- zero results pass, one result fails', async () => {
  const expected = {
    kind: 'negative',
    tier: 'negatives',
    negative_category: 'synthetic_name',
    gold_citations: []
  };

  const bcEmpty = mkCase('c8-empty', expected);
  const prEmpty = mkResult('c8-empty', []);
  const outEmpty = await scoreOne(bcEmpty, prEmpty);
  assert.equal(outEmpty.caseScores[0].score, 1);
  assert.equal(outEmpty.caseScores[0].falsePositive, false);

  const bcHit = mkCase('c8-hit', expected);
  const prHit = mkResult('c8-hit', [{ citation: 'anything' }]);
  const outHit = await scoreOne(bcHit, prHit);
  assert.equal(outHit.caseScores[0].score, 0);
  assert.equal(outHit.caseScores[0].falsePositive, true);
});

test('9. provider failure -> status provider_failure, score 0', async () => {
  const bc = mkCase('c9', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Roe v. Wade',
    gold_citations: [{ canonical_citation: '410 U.S. 113', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('c9', [{ citation: '410 U.S. 113' }], { status: 'error' });
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.status, 'provider_failure');
  assert.equal(cs.score, 0);
});

test('10. name diagnostic -- title matches case_name even when citation does not', async () => {
  const bc = mkCase('c10', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Roe v. Wade',
    gold_citations: [{ canonical_citation: '999 U.S. 999', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('c10', [{ citation: '111 U.S. 111', title: 'Roe v. Wade, 410 U.S. 113' }]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, null);
  assert.equal(cs.nameHitAt1, true);
});

test('11. summary stratification by tier and by axis', async () => {
  const bcQualified = mkCase('c11-qual', {
    kind: 'positive',
    tier: 'qualified',
    name_transform: 'party_misspell',
    case_name: 'Case A',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  });
  const prQualified = mkResult('c11-qual', [{ citation: 'AAA', title: 'Case A' }]);

  const bcAmbiguous = mkCase('c11-ambig', {
    kind: 'positive',
    tier: 'ambiguous',
    name_transform: 'party_order_swap',
    case_name: 'Case B',
    gold_citations: [{ canonical_citation: 'BBB', alternates: [] }],
    avoid_citations: []
  });
  const prAmbiguous = mkResult('c11-ambig', [{ citation: 'not-gold' }]);

  const out = await caseNameLookupScorerAdapter.score({
    manifest: null,
    cases: [bcQualified, bcAmbiguous],
    providerResults: [prQualified, prAmbiguous],
    config: {}
  });

  assert.equal(out.summary.by_tier.qualified.hit_at['hit@1'], 1);
  assert.equal(out.summary.by_tier.ambiguous.hit_at['hit@1'], 0);
  assert.ok(Object.prototype.hasOwnProperty.call(out.summary.by_axis, 'party_misspell'));
  assert.ok(Object.prototype.hasOwnProperty.call(out.summary.by_axis, 'party_order_swap'));
});

test('buildAxisSummary throws on a positive row with no name_transform, naming the row', () => {
  const positives = [
    { caseId: 'c12b-null', rowIndex: 7, tier: 'qualified', nameTransform: null, hitRank: 1, reciprocalRank: 1 }
  ];
  assert.throws(
    () => _internals.buildAxisSummary(positives, CUTOFFS),
    /caseId=c12b-null rowIndex=7/
  );
});

test('12. headline excludes negative rows (dilution guard)', async () => {
  // `scoreCase` recognizes only `kind: 'positive'` and `kind: 'negative'`
  // (party_order_swap is scored as ordinary recall, under `kind: 'positive'`),
  // so a negative row is the only kind that could otherwise dilute the
  // headline: it must never enter `overall`/`overallScore`.
  const bcPositive = mkCase('c12-pos', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Case A'
  });
  const prPositive = mkResult('c12-pos', [{ title: 'Case A' }]);

  const bcNegative = mkCase('c12-neg', {
    kind: 'negative',
    tier: 'negatives',
    negative_category: 'synthetic_name'
  });
  const prNegative = mkResult('c12-neg', [{ citation: 'unexpected' }]); // non-empty -> fails

  const out = await caseNameLookupScorerAdapter.score({
    manifest: null,
    cases: [bcPositive, bcNegative],
    providerResults: [prPositive, prNegative],
    config: {}
  });

  assert.equal(out.summary.overallScore, 1);
  assert.equal(out.summary.negatives_overall.n, 1);
});

// Unit-level: `synthetic` axes (single_party_caption, latin_extended_inject --
// flagged `synthetic: true` by the dataset) are excluded from the tier headline but still
// reported per-axis. Exercises the real aggregation functions via `_internals`
// rather than reimplementing their arithmetic in the test.
const CUTOFFS = [1, 5];

const mkPositive = (nameTransform, synthetic, hitRank) => ({
  tier: 'qualified',
  nameTransform,
  synthetic,
  hitRank,
  reciprocalRank: hitRank === null ? 0 : 1 / hitRank
});

test('tier headline excludes synthetic rows but still reports their axis', () => {
  const positives = [
    mkPositive('party_misspell', false, 1),
    mkPositive('party_misspell', false, null),
    mkPositive('single_party_caption', true, null),
    mkPositive('single_party_caption', true, null)
  ];
  const byTier = _internals.buildTierSummary(positives, CUTOFFS);
  assert.equal(byTier.qualified.n, 2); // 2, not 4
  assert.equal(byTier.qualified.hit_at['hit@1'], 0.5); // 1 of 2

  // The inclusive figure must still be published, not replaced.
  const allAxes = _internals.aggregatePositives(positives, CUTOFFS);
  assert.equal(allAxes.n, 4);
  assert.equal(allAxes.hit_at['hit@1'], 0.25);

  // Same inclusive figure is also nested in the tier summary.
  assert.equal(byTier.qualified.all_axes.n, 4);
  assert.equal(byTier.qualified.all_axes.hit_at['hit@1'], 0.25);

  // The synthetic axis keeps its own per-axis line. No row here carries
  // `arm`, so it defaults to 'perturbed' and there is no control to report.
  const byAxis = _internals.buildAxisSummary(positives, CUTOFFS);
  assert.equal(byAxis.single_party_caption.perturbed.n, 2);
  assert.equal(byAxis.single_party_caption.perturbed.hit_at['hit@1'], 0);
  assert.equal(byAxis.single_party_caption.control, null);
});

// The second test matters: an undefined flag must fail safe *into* the
// headline, not silently out of it -- a row scored by an older version of
// this scorer, from before the `synthetic` field existed, carries no
// `synthetic` key at all.
test('a row with no synthetic flag counts toward the headline', () => {
  const row = mkPositive('clean', undefined, 1);
  assert.equal(_internals.buildTierSummary([row], CUTOFFS).qualified.n, 1);
});

test('headline score is hit@1', () => {
  const scores = [
    { status: 'scored', kind: 'positive', arm: 'perturbed', nameTransform: 'clean', hitRank: 1, dedupedHitRank: 1, reciprocalRank: 1 },
    { status: 'scored', kind: 'positive', arm: 'perturbed', nameTransform: 'clean', hitRank: 3, dedupedHitRank: 3, reciprocalRank: 1 / 3 }
  ];
  const summary = _internals.buildSummary(scores, { manifest: null, cutoffs: [1, 3, 5, 10], headlineCutoff: 1 });
  assert.equal(summary.overallScore, 0.5);
  assert.equal(summary.overall.hit_at['hit@3'], 1);
});

// End-to-end: the same exclusion holds through the full scorer pipeline,
// including the top-level headline (overallScore), not just the unit-level
// aggregation helpers above.
test('overallScore and by_tier headline exclude a synthetic row end to end; all_axes and by_axis do not', async () => {
  const bcClean = mkCase('syn-clean', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Case A',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  });
  const prClean = mkResult('syn-clean', [{ citation: 'AAA' }]); // hit

  const bcSynthetic = mkCase('syn-hit', {
    kind: 'positive',
    tier: 'qualified',
    name_transform: 'single_party_caption',
    synthetic: true,
    case_name: 'In re Case B',
    gold_citations: [{ canonical_citation: 'BBB', alternates: [] }],
    avoid_citations: []
  });
  const prSynthetic = mkResult('syn-hit', [{ citation: 'BBB' }]); // also a hit

  const out = await caseNameLookupScorerAdapter.score({
    manifest: null,
    cases: [bcClean, bcSynthetic],
    providerResults: [prClean, prSynthetic],
    config: {}
  });

  // Headline: only the clean row counts -- n=1, both hits would otherwise
  // read hit@1 = 1 either way, so this alone can't prove exclusion; the n
  // check is load-bearing.
  assert.equal(out.summary.overall.n, 1);
  assert.equal(out.summary.by_tier.qualified.n, 1);

  // Inclusive figure: both rows counted.
  assert.equal(out.summary.overall.all_axes.n, 2);
  assert.equal(out.summary.by_tier.qualified.all_axes.n, 2);

  // by_axis is unaffected -- it still reports the synthetic axis's own line.
  // No row here carries `arm`, so it defaults to 'perturbed' and the control
  // arm is empty -- exactly the control-less shape a run against today's
  // data produces (see `by_axis reports each arm...` below).
  assert.ok(Object.prototype.hasOwnProperty.call(out.summary.by_axis, 'single_party_caption'));
  assert.equal(out.summary.by_axis.single_party_caption.perturbed.n, 1);
  assert.equal(out.summary.by_axis.single_party_caption.control, null);

  // This pins the scorer's VERSION string. A published bundle records the
  // version that scored it, and `verifyResultBundle`'s re-score comparison
  // trusts that string to mean a fixed metric/shape definition (see the
  // VERSION comment in trustfoundry-case-name-lookup.mjs). A scorer with no `synthetic`
  // exclusion at all would score this exact case differently while still
  // claiming an unchanged version string -- this is the one check in this
  // file that would catch that silent mismatch.
  assert.equal(out.summary.execution.scorer.version, 'trustfoundry-case-name-lookup-v9');
});

test('by_axis reports each arm and the within-axis delta', () => {
  const mk = (arm, hitRank) => ({
    status: 'scored', kind: 'positive', nameTransform: 'country_form',
    arm, hitRank, dedupedHitRank: hitRank, reciprocalRank: hitRank ? 1 / hitRank : 0
  });
  const summary = _internals.buildSummary(
    [mk('perturbed', 1), mk('perturbed', null), mk('control', 1), mk('control', 1)],
    { manifest: null, cutoffs: [1, 3, 5, 10], headlineCutoff: 1 }
  );
  const axis = summary.by_axis.country_form;
  assert.equal(axis.perturbed.hit_at['hit@1'], 0.5);
  assert.equal(axis.control.hit_at['hit@1'], 1);
  assert.equal(axis.delta['hit@1'], -0.5);
  // Control rows must not dilute the headline.
  assert.equal(summary.overall.n, 2);
});

test('by_axis reports wrong_name per arm, independently of the other arm', () => {
  const mk = (arm, wrongCount, resultCount) => ({
    status: 'scored', kind: 'positive', nameTransform: 'country_form',
    arm, hitRank: 1, dedupedHitRank: 1, reciprocalRank: 1,
    wrongName: { applicable: true, wrongCount, resultCount }
  });
  const summary = _internals.buildSummary(
    [mk('perturbed', 3, 4), mk('perturbed', 1, 4), mk('control', 0, 4), mk('control', 0, 4)],
    { manifest: null, cutoffs: [1, 3, 5, 10], headlineCutoff: 1 }
  );
  const axis = summary.by_axis.country_form;
  assert.equal(axis.perturbed.wrong_name.rate, 0.5); // (3+1) wrong of (4+4) results
  assert.equal(axis.perturbed.wrong_name.applicable_n, 2);
  assert.equal(axis.perturbed.wrong_name.excluded_n, 0);
  assert.equal(axis.control.wrong_name.rate, 0);
  assert.equal(axis.control.wrong_name.applicable_n, 2);
  assert.equal(axis.control.wrong_name.excluded_n, 0);
});

test('by_axis carries an excluded_n on the arm that owns the stoplist-only row', () => {
  const mk = (wrongName) => ({
    status: 'scored', kind: 'positive', nameTransform: 'country_form',
    arm: 'perturbed', hitRank: 1, dedupedHitRank: 1, reciprocalRank: 1, wrongName
  });
  const summary = _internals.buildSummary(
    [
      mk({ applicable: true, wrongCount: 1, resultCount: 2 }),
      mk({ applicable: false, wrongCount: 0, resultCount: 1 })
    ],
    { manifest: null, cutoffs: [1, 3, 5, 10], headlineCutoff: 1 }
  );
  const wrongName = summary.by_axis.country_form.perturbed.wrong_name;
  assert.equal(wrongName.applicable_n, 1);
  assert.equal(wrongName.excluded_n, 1);
});

test('summary.wrong_name is unaffected by control-arm or synthetic wrongName data', () => {
  // Guards the "must not move" invariant: `summary.wrong_name` stays keyed to
  // the headline population (positive, non-synthetic, perturbed) even once
  // `by_axis` reports the rate on every arm, including control and
  // synthetic rows carrying a deliberately different rate.
  const perturbedRow = {
    status: 'scored', kind: 'positive', nameTransform: 'country_form', synthetic: false,
    arm: 'perturbed', hitRank: 1, dedupedHitRank: 1, reciprocalRank: 1,
    wrongName: { applicable: true, wrongCount: 1, resultCount: 4 }
  };
  const controlRow = {
    status: 'scored', kind: 'positive', nameTransform: 'country_form', synthetic: false,
    arm: 'control', hitRank: 1, dedupedHitRank: 1, reciprocalRank: 1,
    wrongName: { applicable: true, wrongCount: 3, resultCount: 4 }
  };
  const syntheticRow = {
    status: 'scored', kind: 'positive', nameTransform: 'single_party_caption', synthetic: true,
    arm: 'perturbed', hitRank: 1, dedupedHitRank: 1, reciprocalRank: 1,
    wrongName: { applicable: true, wrongCount: 4, resultCount: 4 }
  };
  const summary = _internals.buildSummary(
    [perturbedRow, controlRow, syntheticRow],
    { manifest: null, cutoffs: [1, 3, 5, 10], headlineCutoff: 1 }
  );
  assert.equal(summary.wrong_name.rate, 0.25);
  assert.equal(summary.wrong_name.applicable_n, 1);
  assert.equal(summary.wrong_name.excluded_n, 0);
});

test('summary.headline reflects the perturbed arm alone when the control arm is populated', () => {
  // Guards the population `buildSummary` feeds macroHeadline through
  // `byAxisPerturbed`, not the shape. A shape break (e.g. feeding the raw
  // `{ perturbed, control, delta }` object instead of unwrapping it) is loud
  // and already caught elsewhere. What is NOT caught elsewhere: a change
  // that keeps the shape valid but quietly changes WHICH arm, or how many
  // rows, feed the headline -- merging both arms together, or falling
  // through to control when it exists. Every OTHER headline test in this
  // file runs against today's all-perturbed-by-default data, where the
  // control arm is empty, so none of them can tell "correctly selects
  // perturbed" apart from "selects whatever happens to be the only
  // non-empty arm right now". This fixture makes control non-empty AND
  // gives it a different rate (a perfect 1.0 against the perturbed arm's
  // 0.5) so a wrong selection or a merge is numerically visible.
  const mk = (arm, hitRank) => ({
    status: 'scored', kind: 'positive', nameTransform: 'country_form',
    arm, hitRank, dedupedHitRank: hitRank, reciprocalRank: hitRank ? 1 / hitRank : 0
  });
  const summary = _internals.buildSummary(
    [
      mk('perturbed', 1), mk('perturbed', null),
      mk('control', 1), mk('control', 1), mk('control', 1), mk('control', 1)
    ],
    { manifest: null, cutoffs: [1, 3, 5, 10], headlineCutoff: 1 }
  );
  // Perturbed macro is 0.5 (1 hit, 1 miss); control is a perfect 1.0 over 4
  // rows. If the headline ever includes the control arm -- merged in
  // alongside perturbed, or substituted for it -- this reads higher than
  // 0.5, silently.
  assert.equal(summary.headline.macro, 0.5);
  // n_rows counting the control arm's 4 rows is the same bug wearing a
  // different hat -- only the 2 perturbed rows should be in the headline's
  // row count.
  assert.equal(summary.headline.n_rows, 2);
});

test('13. validateConfig rejects divergent cutoffs', () => {
  assert.throws(() => {
    caseNameLookupScorerAdapter.validateConfig({ scorerConfig: { cutoffs: [1, 5, 10] } });
  }, /cutoffs/);
});

// The shipped config is a separate file from the scorer's own constants --
// nothing but this test keeps them in sync. Editing DEFAULT_HEADLINE_CUTOFF
// or DEFAULT_CUTOFFS without updating the JSON leaves every other test
// green (they exercise the adapter's in-memory defaults, not the file on
// disk), and the mismatch would otherwise surface only at runner startup.
test('the shipped scorer config matches the scorer\'s own cutoff constants', async () => {
  const shipped = await readJson(
    path.join(process.cwd(), 'configs/scorers/trustfoundry-case-name-lookup.json')
  );
  assert.equal(shipped.headline_cutoff, SUPPORTED_HEADLINE_CUTOFF);
  assert.deepEqual(shipped.cutoffs, SUPPORTED_CUTOFFS);
});

test('published rows carry no citation gold', () => {
  // Reads the adapter's REAL declaration, not a copy of it -- a copy would
  // stay green even if `publishedExpectedFields` regressed to re-include
  // `gold_citations`. The input row also actually CARRIES both fields, so
  // their absence below is the allowlist doing its job, not an accident of
  // the fixture never having set them in the first place.
  const [row] = buildRawRows({
    cases: [{
      caseId: 'c',
      prompt: 'q',
      metadata: {
        expected: {
          kind: 'positive',
          case_name: 'A v. B',
          gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
          avoid_citations: [{ canonical_citation: 'BBB', alternates: [] }]
        }
      }
    }],
    providerResults: [{ caseId: 'c', status: 'completed' }],
    caseScores: [{ caseId: 'c', status: 'scored' }],
    publishedExpectedFields: caseNameLookupBenchmarkAdapter.publishedExpectedFields
  });
  assert.equal(row.expected.gold_citations, undefined);
  assert.equal(row.expected.avoid_citations, undefined);
});

test('negatives_overall breaks false positives down by category', async () => {
  const summary = await buildSummaryForCases([
    negativeCase({ negativeCategory: 'party_recombination', falsePositive: false }),
    negativeCase({ negativeCategory: 'party_recombination', falsePositive: true }),
    negativeCase({ negativeCategory: 'corporate_suffix_swap', falsePositive: false }),
    negativeCase({ negativeCategory: 'single_party_caption', falsePositive: true })
  ]);

  assert.equal(summary.negatives_overall.n, 4);
  assert.equal(summary.negatives_overall.fp_rate, 0.5);
  assert.equal(summary.negatives_overall.by_category.party_recombination.fp_rate, 0.5);
  assert.equal(summary.negatives_overall.by_category.corporate_suffix_swap.fp_rate, 0);
  assert.equal(summary.negatives_overall.by_category.single_party_caption.fp_rate, 1);
});

test('negatives with no category are grouped under uncategorized', async () => {
  // The original 50-row tier carries `synthetic_name` / `uncovered_jurisdiction`;
  // a row with a null category must not vanish from the breakdown.
  const summary = await buildSummaryForCases([negativeCase({ negativeCategory: null })]);
  assert.equal(summary.negatives_overall.by_category.uncategorized.n, 1);
});

test('the aggregate fp_rate is unchanged by the breakdown', async () => {
  // Additive only: fp_rate/correct_empty must stay reproducible under this
  // breakdown.
  //
  // BOTH compositions are asserted on purpose. With fp = 0, `correct_empty:
  // n - fp` and a broken `correct_empty: n` produce the identical answer, so
  // a clean-only (fp = 0) fixture cannot tell the two apart -- it would pass
  // even if `correct_empty` silently dropped the `- fp` term. The fp > 0
  // composition is what makes `n - fp` observable, so the second block is
  // the load-bearing half.
  const clean = await buildSummaryForCases([
    negativeCase({ negativeCategory: 'synthetic_name', falsePositive: false }),
    negativeCase({ negativeCategory: 'synthetic_name', falsePositive: false })
  ]);
  assert.equal(clean.negatives_overall.n, 2);
  assert.equal(clean.negatives_overall.fp_rate, 0);
  assert.equal(clean.negatives_overall.correct_empty, 2);

  // 5 rows, 2 of them false positives: n = 5, fp_rate = 0.4,
  // correct_empty = 3. The three published quantities are now each pinned to
  // a value no other plausible formula produces -- `correct_empty` is neither
  // `n` (5) nor `fp` (2) nor `n` at any other fp count.
  const withFalsePositives = await buildSummaryForCases([
    negativeCase({ negativeCategory: 'synthetic_name', falsePositive: true }),
    negativeCase({ negativeCategory: 'synthetic_name', falsePositive: false }),
    negativeCase({ negativeCategory: 'uncovered_jurisdiction', falsePositive: true }),
    negativeCase({ negativeCategory: 'uncovered_jurisdiction', falsePositive: false }),
    negativeCase({ negativeCategory: 'uncovered_jurisdiction', falsePositive: false })
  ]);
  assert.equal(withFalsePositives.negatives_overall.n, 5);
  assert.equal(withFalsePositives.negatives_overall.fp_rate, 0.4);
  assert.equal(withFalsePositives.negatives_overall.correct_empty, 3);
  // Stated as a relation as well as a value, so a future change to the row
  // mix cannot quietly turn this back into an fp = 0 tautology.
  assert.notEqual(
    withFalsePositives.negatives_overall.correct_empty,
    withFalsePositives.negatives_overall.n
  );

  // Same arithmetic, per category. `by_category` is the new field, and it
  // carries its own `correct_empty` on the same `count - fpCount` shape --
  // untested against a nonzero fp until now.
  const byCategory = withFalsePositives.negatives_overall.by_category;
  assert.equal(byCategory.synthetic_name.n, 2);
  assert.equal(byCategory.synthetic_name.fp_rate, 0.5);
  assert.equal(byCategory.synthetic_name.correct_empty, 1);
  assert.equal(byCategory.uncovered_jurisdiction.n, 3);
  assert.equal(byCategory.uncovered_jurisdiction.correct_empty, 2);
});

// ---- hit@3 and the caption-deduplicated rank ----

test('14. cutoffs include 3, reported alongside the hit@1 headline', async () => {
  const bc = mkCase('c14', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Searoad v. Dupont',
    gold_citations: [{ canonical_citation: '361 F.2d 833', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('c14', [
    { citation: 'not-gold-1' },
    { citation: 'not-gold-2' },
    { citation: '361 F.2d 833', title: 'Searoad v. Dupont' }
  ]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.ok('hitAt3' in cs, 'hit@3 must be reported');
  assert.equal(cs.hitRank, 3);
  assert.equal(cs.hitAt3, true);
});

// Caption repetition is real, not hypothetical: real search results for a
// common case name can return several raw header strings that collapse to
// far fewer distinct cases once `normalizeName` folds case-only and minor
// formatting differences together -- for example, 10 result slots holding
// only 3 distinct raw header strings and 2 distinct cases after
// normalization.
//
// Any figure quoted in this file should be a concrete, checkable example
// like the one above, not an assertion with no way to judge whether it's
// plausible.
//
// `dedupedHitRank` counts distinct captions by page slot, not gold-match
// status, up to the first gold hit.
test('15. duplicate captions do not consume page slots in the deduped rank', async () => {
  const bc = mkCase('dedup-1', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Nguyen v. Barnes & Noble Inc.',
    gold_citations: [{ canonical_citation: 'D', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('dedup-1', [
    { citation: 'A', title: 'Express Mobile, Inc. v. GoDaddy.com, LLC' },
    { citation: 'B', title: 'Express Mobile, Inc. v. GoDaddy.com, LLC' },
    { citation: 'C', title: 'Express Mobile, Inc. v. GoDaddy.com, LLC' },
    { citation: 'D', title: 'Nguyen v. Barnes & Noble Inc.' }
  ]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, 4);
  assert.equal(cs.dedupedHitRank, 2);
  assert.equal(cs.distinctInTop5, 2);
});

test('16. dedup never merges two different cases', async () => {
  // Real labelled negative pair. A more aggressive fold would collapse it.
  const bc = mkCase('dedup-2', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Gibbs v. H.J. Heinz Company',
    gold_citations: [{ canonical_citation: 'A', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('dedup-2', [
    { citation: 'A', title: 'Gibbs v. H.J. Heinz Company' },
    { citation: 'B', title: 'Gibbs v. H. T. Henning Co.' }
  ]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.distinctInTop5, 2);
  assert.equal(cs.dedupedHitRank, 1);
});

// `distinctInTop5` counts distinct captions among the first 5 page SLOTS,
// not the first 5 distinct captions ever seen -- ten results whose first
// five slots are all one caption must report 1, not 5. This exercises that
// by slicing `results` (page slots) before counting distinct names.
test('17. distinctInTop5 counts distinct captions in the first 5 SLOTS, not the first 5 distinct names', async () => {
  const bc = mkCase('dedup-3', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Target Case',
    gold_citations: [{ canonical_citation: 'J', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('dedup-3', [
    { citation: 'A', title: 'Roe v. Wade' },
    { citation: 'B', title: 'Roe v. Wade' },
    { citation: 'C', title: 'Roe v. Wade' },
    { citation: 'D', title: 'Roe v. Wade' },
    { citation: 'E', title: 'Roe v. Wade' },
    { citation: 'F', title: 'Roe v. Doe' },
    { citation: 'G', title: 'Roe v. Doe 2' },
    { citation: 'H', title: 'Roe v. Doe 3' },
    { citation: 'I', title: 'Roe v. Doe 4' },
    { citation: 'J', title: 'Target Case' }
  ]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.distinctInTop5, 1);
});

test('18. dedupedHitRank is null on every early-return path (provider failure, negative), same as hitRank', async () => {
  // `scoreCase` throws on any kind other than 'positive'/'negative', so
  // provider_failure and negative are the only two hardcoded-null-return
  // paths to cover.
  const positiveExpected = {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Case A',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  };

  // provider_failure
  const outFailure = await scoreOne(
    mkCase('early-fail', positiveExpected),
    mkResult('early-fail', [{ citation: 'AAA' }], { status: 'error' })
  );
  assert.equal(outFailure.caseScores[0].hitRank, null);
  assert.equal(outFailure.caseScores[0].dedupedHitRank, null);

  // negative
  const negativeExpected = {
    kind: 'negative',
    tier: 'negatives',
    negative_category: 'synthetic_name',
    gold_citations: []
  };
  const outNegative = await scoreOne(
    mkCase('early-neg', negativeExpected),
    mkResult('early-neg', [{ citation: 'anything' }])
  );
  assert.equal(outNegative.caseScores[0].hitRank, null);
  assert.equal(outNegative.caseScores[0].dedupedHitRank, null);
});

test('scoreCase throws on an unrecognized kind instead of scoring it silently into no aggregate', async () => {
  const bc = mkCase('bad-kind', {
    kind: 'precision',
    tier: 'qualified',
    case_name: 'Wade v. Roe',
    gold_citations: [],
    avoid_citations: [{ canonical_citation: '410 U.S. 113', alternates: [] }]
  });
  const pr = mkResult('bad-kind', [{ citation: '410 U.S. 113' }]);
  await assert.rejects(() => scoreOne(bc, pr), /unrecognized kind/);
});

test('19. aggregate reports deduped_hit_at alongside hit_at', async () => {
  // Two positive rows: row A's gold hit carries a self-reported rank of 2
  // (hitRank honors a provider's own `rank` field) but sits at array slot 0 --
  // dedupedHitRank is computed by page slot regardless of the self-reported
  // rank (see the comment above `dedupedRankFields` and test 23), so it reads
  // 1. Built directly, not via `mkResult` (which always sets `rank: index +
  // 1`), so the two can diverge; row B misses entirely.
  const bcA = mkCase('agg-a', { kind: 'positive', tier: 'qualified', case_name: 'Case A' });
  const prA = {
    caseId: 'agg-a',
    status: 'completed',
    finalOutputText: JSON.stringify({
      query: 'q',
      result_count: 1,
      results: [{ rank: 2, citation: 'AAA', title: 'Case A', header: 'Case A' }]
    }),
    timing: { durationMs: 100 }
  };

  const expectedB = {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Case B',
    gold_citations: [{ canonical_citation: 'BBB', alternates: [] }],
    avoid_citations: []
  };
  const bcB = mkCase('agg-b', expectedB);
  const prB = mkResult('agg-b', [{ citation: 'not-gold' }]);

  const out = await caseNameLookupScorerAdapter.score({
    manifest: null,
    cases: [bcA, bcB],
    providerResults: [prA, prB],
    config: {}
  });

  const csA = out.caseScores[0];
  assert.equal(csA.hitRank, 2);
  assert.equal(csA.dedupedHitRank, 1);

  // Raw hit@1: only rank<=1 counts -> 0 of 2. Deduped hit@1: dedupedHitRank
  // 1 counts -> 1 of 2. The dedup must not change hit@3/hit@5 (both rows'
  // raw and deduped ranks are already <= those cutoffs or null).
  assert.equal(out.summary.overall.hit_at['hit@1'], 0);
  assert.equal(out.summary.overall.deduped_hit_at['hit@1'], 0.5);
});

// ---- dedupedHitRank null-collapse regression ----

test('20. dedupedHitRank is non-null when the gold hit itself is uncaptioned', () => {
  // An uncaptioned slot pushes no key, so `seen.length` alone cannot tell
  // "found at slot 1" apart from "never found" -- both read 0. A caption-based
  // `hitRank` can never match an uncaptioned result on its own, so this
  // scenario is not reachable through the full scoreCase pipeline -- it
  // exercises `dedupedRankFields` directly with an `isGoldHit` predicate
  // shaped exactly like the one `scoreCase` builds from `hitPredicate`, so
  // the case where the matched slot itself carries no caption stays covered:
  // a real hit at an uncaptioned slot 1 must still read `dedupedHitRank: 1`,
  // not `null`.
  const results = [{ citation: 'AAA', title: null }];
  const { dedupedHitRank } = _internals.dedupedRankFields(results, (index) => index === 0);
  assert.equal(dedupedHitRank, 1);
});

test('21. a run of uncaptioned results before the gold still yields a non-null, correctly-counted dedupedHitRank', async () => {
  const bc = mkCase('null-cap-2', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Case B',
    gold_citations: [{ canonical_citation: 'BBB', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('null-cap-2', [
    { citation: 'not-gold-1', title: null },
    { citation: 'not-gold-2', title: null },
    { citation: 'BBB', title: 'Case B' }
  ]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, 3);
  // Two uncaptioned slots, each counted as its own distinct entry (an
  // unlabelled result is not "the same" as another unlabelled result), plus
  // the captioned hit slot itself -> 3 distinct entries inspected.
  assert.equal(cs.dedupedHitRank, 3);
});

test('22. invariants: dedupedHitRank is non-null whenever hitRank is non-null, and dedupedHitRank <= hitRank', async () => {
  // The hit in every scenario is identified by CAPTION (a title matching
  // `case_name`), not citation -- a caption-based `hitRank` cannot match an
  // uncaptioned result on its own, so a scenario where the sole result is
  // both the hit and uncaptioned is not reachable here; that case is covered
  // directly at the `dedupedRankFields` level by test 20.
  const scenarios = [
    [{ title: 'Target Case' }],
    [{ title: 'Dup' }, { title: 'Dup' }, { title: 'Target Case' }],
    [{ title: 'Dup' }, { title: null }, { title: 'Dup' }, { title: 'Target Case' }],
    [{ title: null }, { title: null }, { title: 'Target Case' }],
    [{ title: 'Dup' }, { title: 'Dup' }, { title: 'Dup' }, { title: 'Target Case' }]
  ];
  for (const entries of scenarios) {
    const bc = mkCase('inv', {
      kind: 'positive',
      tier: 'qualified',
      case_name: 'Target Case'
    });
    const pr = mkResult('inv', entries);
    const out = await scoreOne(bc, pr);
    const cs = out.caseScores[0];
    assert.notEqual(cs.hitRank, null, 'sanity: scenario must actually hit');
    assert.notEqual(
      cs.dedupedHitRank,
      null,
      `dedupedHitRank must be non-null whenever hitRank is (${JSON.stringify(entries)})`
    );
    assert.ok(
      cs.dedupedHitRank <= cs.hitRank,
      `dedupedHitRank (${cs.dedupedHitRank}) must not exceed hitRank (${cs.hitRank})`
    );
  }
});

// Characterization test (not a bug to fix -- see the code comment above
// `dedupedRankFields`): `dedupedHitRank` is computed by
// page slot, `hitRank` honors a provider's self-reported `rank` field when
// present, and the two CAN diverge if a provider misreports `rank`. This
// pins that documented, latent behavior rather than silently losing it to a
// future refactor. `mkResult` always sets `rank: i + 1` (slot-aligned, as
// the one live provider does), so this test builds the provider result
// directly to construct the mismatch.
test('23. dedupedHitRank is computed by page slot, not by a self-reported rank field, and can therefore exceed hitRank if a provider misreports rank', async () => {
  const bc = mkCase('rank-mismatch', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Case Z',
    gold_citations: [{ canonical_citation: 'ZZZ', alternates: [] }],
    avoid_citations: []
  });
  const pr = {
    caseId: 'rank-mismatch',
    status: 'completed',
    finalOutputText: JSON.stringify({
      query: 'q',
      result_count: 5,
      results: [
        { rank: 1, citation: 'A', title: 'Case W' },
        { rank: 1, citation: 'B', title: 'Case X' },
        { rank: 1, citation: 'C', title: 'Case Y' },
        { rank: 1, citation: 'D', title: 'Case V' },
        { rank: 1, citation: 'ZZZ', title: 'Case Z' }
      ]
    }),
    timing: { durationMs: 100 }
  };
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  // firstMatchRank honors the (bogus) self-reported rank field -> 1.
  assert.equal(cs.hitRank, 1);
  // dedupedHitRank counts by actual array slot, ignoring `rank` -> 5
  // distinct captions inspected to reach the gold entry at array index 4.
  assert.equal(cs.dedupedHitRank, 5);
});

// ---- distinctInTop5 on a provider-failure row ----

test('24. distinctInTop5 is null, not 0, on a provider_failure row -- results were never parsed', async () => {
  const bc = mkCase('fail-distinct', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Case A',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('fail-distinct', [{ citation: 'AAA' }], { status: 'error' });
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.status, 'provider_failure');
  assert.equal(cs.dedupedHitRank, null);
  assert.equal(cs.distinctInTop5, null);
});

// --- party_order_swap is a RECALL axis ---------------------------------------
//
// Querying `B v. A` should still surface `A v. B`: the gold is the original
// document, and the row is scored like any other recall axis. The ranking
// claim -- a real `B v. A`, where one exists, should outrank `A v. B` --
// survives as a separate CONDITIONAL assertion on the row (`orderPreference`),
// not as the row's pass/fail criterion.

const GOLD_CITE = '410 U.S. 113';
const GOLD_NAME = 'Roe v. Wade';
const SWAPPED = 'Wade v. Roe';
const OTHER_CITE = '999 F.3d 1';

function mkSwapCase(caseId, { query = SWAPPED, transform = 'party_order_swap' } = {}) {
  const c = mkCase(caseId, {
    kind: 'positive',
    tier: 'qualified',
    name_transform: transform,
    case_name: GOLD_NAME,
    gold_citations: [{ canonical_citation: GOLD_CITE, alternates: [] }],
    avoid_citations: []
  });
  c.prompt = query;
  return c;
}

test('an order-swapped query scores as a HIT when the original case comes back', async () => {
  const c = mkSwapCase('swap-hit');
  const out = await scoreOne(c, mkResult('swap-hit', [{ citation: GOLD_CITE, title: GOLD_NAME }]));
  const row = out.caseScores[0];
  assert.equal(row.score, 1);
  assert.equal(row.hitRank, 1);
  assert.equal(row.kind, 'positive');
});

test('order preference is NOT exercised when no real reversal comes back', async () => {
  const c = mkSwapCase('swap-unpaired');
  const out = await scoreOne(c, mkResult('swap-unpaired', [{ citation: GOLD_CITE, title: GOLD_NAME }]));
  const pref = out.caseScores[0].orderPreference;
  assert.equal(pref.exercised, false);
  assert.equal(pref.reversedRank, null);
  assert.equal(pref.originalRank, 1);
  assert.equal(pref.satisfied, null);
});

test('order preference is satisfied when the real reversal outranks the original', async () => {
  const c = mkSwapCase('swap-ok');
  const out = await scoreOne(c, mkResult('swap-ok', [
    { citation: OTHER_CITE, title: SWAPPED },
    { citation: GOLD_CITE, title: GOLD_NAME }
  ]));
  const pref = out.caseScores[0].orderPreference;
  assert.equal(pref.exercised, true);
  assert.equal(pref.reversedRank, 1);
  assert.equal(pref.originalRank, 2);
  assert.equal(pref.satisfied, true);
});

test('order preference is VIOLATED when the original outranks the real reversal', async () => {
  const c = mkSwapCase('swap-bad');
  const out = await scoreOne(c, mkResult('swap-bad', [
    { citation: GOLD_CITE, title: GOLD_NAME },
    { citation: OTHER_CITE, title: SWAPPED }
  ]));
  const row = out.caseScores[0];
  assert.equal(row.orderPreference.exercised, true);
  assert.equal(row.orderPreference.satisfied, false);
  // ...and it must NOT have changed whether the row counts as a hit.
  assert.equal(row.score, 1);
  assert.equal(row.hitRank, 1);
});

test('order preference is null on every axis that is not party_order_swap', async () => {
  const c = mkSwapCase('swap-other', { query: 'Roe v. Wade', transform: 'separator_swap' });
  const out = await scoreOne(c, mkResult('swap-other', [{ citation: GOLD_CITE, title: GOLD_NAME }]));
  assert.equal(out.caseScores[0].orderPreference, null);
});

test('a THIRD case whose caption merely contains the query is not the reversal', async () => {
  // A real corpus shape this guards against. Query `Womack-Grey v. State`,
  // gold `State v. Womack-Grey`:
  // the gold came back at rank 1 and `State ex rel. Womack-Grey v. State` at
  // rank 2. Under containment that reported a VIOLATION -- but the second
  // slot is a different case, not the typed one, and the ranking was correct.
  // The spec's claim is about `B v. A` being in the corpus, so the caption has
  // to BE the typed name.
  const c = mkSwapCase('swap-substring');
  const out = await scoreOne(c, mkResult('swap-substring', [
    { citation: GOLD_CITE, title: GOLD_NAME },
    { citation: OTHER_CITE, title: `State ex rel. ${SWAPPED}` }
  ]));
  const pref = out.caseScores[0].orderPreference;
  assert.equal(pref.exercised, false);
  assert.equal(pref.reversedRank, null);
});

test('a slot that IS the gold document cannot count as the reversal', async () => {
  // Guards the degenerate case where a single slot's title and header
  // disagree about the caption (a real corpus data artifact): the gold
  // exclusion is keyed on caption now, not citation, so if EITHER field on a
  // slot reads as the gold caption, that slot is the answer, not a competing
  // reversal -- even though the OTHER field on that same slot happens to read
  // as the swapped text. Built directly (not via `mkResult`, which always
  // sets header === title) so title and header can disagree on one slot.
  const c = mkSwapCase('swap-selfmatch');
  const out = await scoreOne(c, {
    caseId: 'swap-selfmatch',
    status: 'completed',
    finalOutputText: JSON.stringify({
      query: 'q',
      result_count: 1,
      results: [{ rank: 1, citation: GOLD_CITE, title: GOLD_NAME, header: SWAPPED }]
    }),
    timing: { durationMs: 100 }
  });
  const pref = out.caseScores[0].orderPreference;
  assert.equal(pref.exercised, false);
  assert.equal(pref.reversedRank, null);
});

// --- v2 macro-averaged headline ---------------------------------------------
//
// The v2 headline is the macro-average of hit@3 across ALL categories, each
// equally weighted. Because allocation is exactly equal (264 rows per
// category), macro-average and pooled rate are the same number -- there is no
// weighting choice to defend and no way to move the headline by re-weighting.
// Reporting both is what makes an allocation drift visible instead of silent.

function mkHeadlineRow(caseId, transform, { hit }) {
  const c = mkCase(caseId, {
    kind: 'positive',
    tier: 'qualified',
    name_transform: transform,
    case_name: 'Roe v. Wade',
    gold_citations: [{ canonical_citation: '410 U.S. 113', alternates: [] }],
    avoid_citations: []
  });
  c.prompt = 'q';
  const entries = hit
    ? [{ citation: '410 U.S. 113', title: 'Roe v. Wade' }]
    : [{ citation: '777 F.2d 9', title: 'Other v. Case' }];
  return [c, mkResult(caseId, entries)];
}

// `spec` is { transform: [hit, hit, ...] }
async function scoreCategories(spec) {
  const cases = [];
  const results = [];
  let i = 0;
  for (const [transform, hits] of Object.entries(spec)) {
    for (const hit of hits) {
      const [c, r] = mkHeadlineRow(`row-${i++}`, transform, { hit });
      cases.push(c);
      results.push(r);
    }
  }
  return caseNameLookupScorerAdapter.score({ manifest: null, cases, providerResults: results, config: {} });
}

test('the headline is the macro-average of hit@1 across categories', async () => {
  const out = await scoreCategories({
    clean: [true, true, true, true],
    separator_swap: [true, true, true, false],
    party_misspell: [true, false, false, false]
  });
  const h = out.summary.headline;
  assert.equal(h.metric, 'macro_hit_at_1');
  assert.equal(h.n_categories, 3);
  // (1.00 + 0.75 + 0.25) / 3
  assert.ok(Math.abs(h.macro - 2 / 3) < 1e-12);
});

test('macro equals pooled under exactly equal allocation', async () => {
  const out = await scoreCategories({
    clean: [true, true, true, false],
    separator_swap: [true, true, false, false],
    party_misspell: [true, false, false, false]
  });
  const h = out.summary.headline;
  assert.ok(Math.abs(h.macro - h.pooled) < 1e-9, `${h.macro} vs ${h.pooled}`);
});

test('macro diverges from pooled when allocation is not equal', async () => {
  // The property the equal-allocation gate exists to protect: if the two ever
  // separate, the headline has become a weighting choice.
  const out = await scoreCategories({
    clean: [true],
    separator_swap: [false, false, false, false, false, false, false, false, false]
  });
  const h = out.summary.headline;
  assert.ok(Math.abs(h.macro - h.pooled) > 0.3, `${h.macro} vs ${h.pooled}`);
});

test('the headline carries a Wilson interval computed from the closed form', async () => {
  // 245/264 hand-computed from the closed form -- pinning these exact
  // constants is what keeps this Wilson computation from silently drifting.
  const { wilsonInterval } = _internals;
  const [lo, hi] = wilsonInterval(245, 264);
  assert.equal(Number(lo.toFixed(4)), 0.8903);
  assert.equal(Number(hi.toFixed(4)), 0.9534);
  assert.deepEqual(wilsonInterval(0, 0), [0, 1]);
  const [lo1, hi1] = wilsonInterval(264, 264);
  assert.equal(hi1, 1);
  assert.equal(Number(lo1.toFixed(4)), 0.9857);
});

test('the headline interval brackets the macro-average', async () => {
  const out = await scoreCategories({
    clean: [true, true, true, false],
    separator_swap: [true, true, false, false]
  });
  const h = out.summary.headline;
  assert.ok(h.ci95[0] < h.macro && h.macro < h.ci95[1]);
});

test('every category appears in the headline breakdown with its own n and interval', async () => {
  const out = await scoreCategories({
    clean: [true, true],
    separator_swap: [true, false]
  });
  const per = out.summary.headline.per_category;
  assert.deepEqual(Object.keys(per).sort(), ['clean', 'separator_swap']);
  for (const entry of Object.values(per)) {
    assert.equal(entry.n, 2);
    assert.ok(Array.isArray(entry.ci95));
    assert.ok(entry.ci95[0] <= entry['hit@1'] && entry['hit@1'] <= entry.ci95[1]);
  }
});

test('the headline weights every category equally regardless of its name', async () => {
  // macroHeadline has no per-category carve-out: every key present in
  // `by_axis` counts toward the macro-average on equal footing.
  const out = await scoreCategories({
    clean: [true, true],
    unusual_axis_a: [false, false],
    unusual_axis_b: [false, false]
  });
  const h = out.summary.headline;
  assert.equal(h.n_categories, 3);
  assert.ok(Math.abs(h.macro - 1 / 3) < 1e-12);
});

// --- single_party_search is scored by NAME, not by citation ------------------
//
// Searching one party ("Nguyen") cannot demand a specific case back: many
// cases share a surname, so requiring the one we drew it from would measure
// ranking luck rather than capability. If a user searches a bare surname,
// any case naming that party on either side is a legitimate match. Success
// is therefore "the page shows a case carrying that party name".
//
// This is the ONLY category scored this way; every other axis matches by
// caption equality against the full case name.

function mkPartySearch(caseId, surname, resultTitles) {
  const c = mkCase(caseId, {
    kind: 'positive',
    tier: 'qualified',
    name_transform: 'single_party_search',
    case_name: 'Nguyen v. Holder',
    gold_citations: [{ canonical_citation: '999 F.3d 1', alternates: [] }],
    avoid_citations: []
  });
  c.prompt = surname;
  return [c, mkResult(caseId, resultTitles.map((t) => ({ citation: '111 F.3d 2', title: t })))];
}

test('a party search passes when any returned case carries that party name', async () => {
  // Note the citation returned is NOT the gold citation -- under citation
  // scoring this row would be a miss.
  const [c, r] = mkPartySearch('ps-hit', 'Nguyen', ['Nguyen v. Barnes', 'Smith v. Jones']);
  const row = (await scoreOne(c, r)).caseScores[0];
  assert.equal(row.hitRank, 1);
  assert.equal(row.score, 1);
});

test('a party search fails when no returned case carries the name', async () => {
  const [c, r] = mkPartySearch('ps-miss', 'Nguyen', ['Smith v. Jones', 'Brown v. Board']);
  const row = (await scoreOne(c, r)).caseScores[0];
  assert.equal(row.hitRank, null);
  assert.equal(row.score, 0);
});

test('a party search fails on an empty page', async () => {
  const [c, r] = mkPartySearch('ps-empty', 'Nguyen', []);
  const row = (await scoreOne(c, r)).caseScores[0];
  assert.equal(row.hitRank, null);
  assert.equal(row.resultCount, 0);
});

test('the name match is position-based, so rank 2 reports as rank 2', async () => {
  const [c, r] = mkPartySearch('ps-rank2', 'Nguyen', ['Smith v. Jones', 'Doe v. Nguyen']);
  const row = (await scoreOne(c, r)).caseScores[0];
  assert.equal(row.hitRank, 2);
});

test('every other category rejects a different case sharing a party name', async () => {
  // Outside single_party_search, a hit needs the full caption to match, not
  // just a shared party name: the returned title carries the query's surname
  // ("Nguyen") but is a different case than gold, so this is a MISS.
  const c = mkCase('cite-scored', {
    kind: 'positive', tier: 'qualified', name_transform: 'separator_swap',
    case_name: 'Nguyen v. Holder'
  });
  c.prompt = 'Nguyen';
  const r = mkResult('cite-scored', [{ citation: '111 F.3d 2', title: 'Nguyen v. Barnes' }]);
  const row = (await scoreOne(c, r)).caseScores[0];
  assert.equal(row.hitRank, null);
});

// --- caption equality is the hit rule ---------------------------------------
//
// A hit is "a case with this name came back", not "we returned this exact
// citation". `captionHitRank` is the unit under test; `scoreCase` wiring
// (below) is what actually retires citation identity as the scoring input.

test('captionHitRank matches on normalized equality', () => {
  const results = [{ rank: 1, header: 'Smith v. Jones' }];
  assert.equal(captionHitRank(results, 'smith v jones'), 1);
});

test('captionHitRank does not match a longer different case', () => {
  const results = [{ rank: 1, header: 'Smith v. Jones Manufacturing Co.' }];
  assert.equal(captionHitRank(results, 'smith v jones'), null);
});

test('captionHitRank returns the rank of the first match, not the index', () => {
  const results = [
    { rank: 4, header: 'Other v. Case' },
    { rank: 7, header: 'Smith v. Jones' }
  ];
  assert.equal(captionHitRank(results, 'smith v jones'), 7);
});

test('captionHitRank ignores results outside the requested jurisdiction', () => {
  const results = [{ rank: 1, header: 'Smith v. Jones', second_level_geo: 'ny' }];
  assert.equal(captionHitRank(results, 'smith v jones', { jurisdiction: 'ca' }), null);
});

// --- the fragment axis needs containment, not equality ----------------------
//
// `single_party_search`'s query is a bare party name, and a bare `Corcoran`
// can never equal `Corcoran v. State` -- equality alone makes the axis
// unreachable. `match: 'contains'` restores the carve-out with whole-token
// containment: every token of the query must appear as its own token in the
// caption, so a fragment can still credit the case it names without the raw
// substring failure mode (`Brown` inside `Browning`) equality was chosen
// elsewhere to avoid.

test('captionHitRank in contains mode matches a bare surname against a full caption', () => {
  const results = [{ rank: 1, header: 'Nguyen v. Barnes' }];
  assert.equal(captionHitRank(results, 'Nguyen', { match: 'contains' }), 1);
});

test('captionHitRank in contains mode does not credit a token fragment (Brown does not match Browning)', () => {
  const results = [{ rank: 1, header: 'Browning v. State' }];
  assert.equal(captionHitRank(results, 'Brown', { match: 'contains' }), null);
});

test('captionHitRank stays equality by default -- a non-fragment axis does not fall back to containment', () => {
  const results = [{ rank: 1, header: 'Smith v. Jones Manufacturing Co.' }];
  assert.equal(captionHitRank(results, 'smith v jones'), null);
});

// --- jurisdiction casing and hitRank/dedupedHitRank parity ------------------

test('captionHitRank case-folds the jurisdiction compare -- real data is not case-aligned', () => {
  // geo_level_2_identifier is lowercase ('ct'); providers return
  // second_level_geo upper ('CT'). A strict compare turns the "should never
  // fire" guard into "fires on every in-jurisdiction result."
  const results = [{ rank: 1, header: 'Smith v. Jones', second_level_geo: 'CT' }];
  assert.equal(captionHitRank(results, 'smith v jones', { jurisdiction: 'ct' }), 1);
});

test('captionHitRank throws on an unrecognized match mode instead of silently reading as equality', () => {
  const results = [{ rank: 1, header: 'Smith v. Jones' }];
  assert.throws(
    () => captionHitRank(results, 'smith v jones', { match: 'startswith' }),
    /unrecognized match mode/
  );
});

// dedupedHitRank and hitRank must agree on what counts as a hit, jurisdiction
// guard included -- a caption match the guard excludes has to be a miss on
// BOTH paths, or the deduped column stops describing the same hit the
// headline is built from.

test('a same-jurisdiction match counts as a hit through the full pipeline even when the casing differs', async () => {
  const bc = mkCase('juris-match', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Smith v. Jones',
    geo_level_2_identifier: 'ct',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  });
  const pr = {
    caseId: 'juris-match',
    status: 'completed',
    finalOutputText: JSON.stringify({
      query: 'q',
      result_count: 1,
      results: [
        { rank: 1, citation: 'AAA', title: 'Smith v. Jones', header: 'Smith v. Jones', second_level_geo: 'CT' }
      ]
    }),
    timing: { durationMs: 100 }
  };
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, 1);
  assert.equal(cs.dedupedHitRank, 1);
});

// ---- wrong-name rate ----
//
// A different question from recall: was the page polluted with results
// sharing no distinctive party token with the query, after the stoplist
// drops tokens too common to carry any identifying signal.

test('a result sharing a distinctive token is not wrong-named', () => {
  const out = _internals.wrongNameFields([{ header: 'Brown v. United States' }], 'brown');
  assert.equal(out.applicable, true);
  assert.equal(out.wrongCount, 0);
});

test('an unrelated case is wrong-named', () => {
  const out = _internals.wrongNameFields([{ header: 'Roe v. Wade' }], 'brown');
  assert.equal(out.wrongCount, 1);
});

test('stoplist tokens alone do not make a result consistent', () => {
  const out = _internals.wrongNameFields([{ header: 'Smith v. State' }], 'jones v state');
  assert.equal(out.wrongCount, 1);
});

test('a query with no distinctive token is not applicable', () => {
  const out = _internals.wrongNameFields([{ header: 'Anything v. Else' }], 'State');
  assert.equal(out.applicable, false);
  assert.equal(out.wrongCount, 0);
});

// wrongNameRateFields is the one place the rate/applicable_n/excluded_n
// shape is computed -- both `summary.wrong_name` and each `by_axis` arm
// call it rather than re-deriving the arithmetic.

test('wrongNameRateFields sums wrong results over total results across cases, excluding inapplicable ones', () => {
  const cases = [
    { wrongName: { applicable: true, wrongCount: 1, resultCount: 4 } },
    { wrongName: { applicable: true, wrongCount: 0, resultCount: 2 } },
    { wrongName: { applicable: false, wrongCount: 0, resultCount: 3 } }
  ];
  const out = _internals.wrongNameRateFields(cases);
  assert.equal(out.rate, 1 / 6);
  assert.equal(out.applicable_n, 2);
  assert.equal(out.excluded_n, 1);
});

test('wrongNameRateFields reads a zero rate, not a division error, over an empty or all-excluded population', () => {
  assert.deepEqual(_internals.wrongNameRateFields([]), { rate: 0, applicable_n: 0, excluded_n: 0 });
  const allExcluded = [{ wrongName: { applicable: false, wrongCount: 0, resultCount: 1 } }];
  assert.deepEqual(_internals.wrongNameRateFields(allExcluded), { rate: 0, applicable_n: 0, excluded_n: 1 });
});

test('wrongNameRateFields treats a missing wrongName as excluded rather than throwing', () => {
  const out = _internals.wrongNameRateFields([{}, { wrongName: null }]);
  assert.deepEqual(out, { rate: 0, applicable_n: 0, excluded_n: 2 });
});

test('hitRank and dedupedHitRank agree when the jurisdiction guard excludes the only caption match', async () => {
  const bc = mkCase('juris-mismatch', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Smith v. Jones',
    geo_level_2_identifier: 'ct',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  });
  const pr = {
    caseId: 'juris-mismatch',
    status: 'completed',
    finalOutputText: JSON.stringify({
      query: 'q',
      result_count: 1,
      results: [
        { rank: 1, citation: 'AAA', title: 'Smith v. Jones', header: 'Smith v. Jones', second_level_geo: 'NY' }
      ]
    }),
    timing: { durationMs: 100 }
  };
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, null);
  // The reverse of test 22's invariant: dedupedHitRank must be null whenever
  // hitRank is null for jurisdiction reasons, not just non-null whenever
  // hitRank is.
  assert.equal(cs.dedupedHitRank, null);
});

// ---- diacritic folding ----
//
// A caption differing only by an accent is the same case name: `Peña` and
// `Pena` must normalize identically so the hit rule and the wrong-name
// tokenizer (both built on `normalizeName`) treat them as the same party.

test('normalizeName folds an accented letter to its unaccented form', () => {
  assert.equal(_internals.normalizeName('Peña'), _internals.normalizeName('Pena'));
  assert.equal(_internals.normalizeName('Peña v. State'), 'pena v state');
});

test('normalizeName does not fold a ligature (NFD is diacritic folding, not ligature folding)', () => {
  assert.equal(_internals.normalizeName('Æthelred'), 'æthelred');
  assert.notEqual(_internals.normalizeName('Æthelred'), _internals.normalizeName('Aethelred'));
});

test('an accented gold caption matches an unaccented returned caption', async () => {
  const bc = mkCase('accent-gold', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Peña v. State',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('accent-gold', [{ citation: 'AAA', title: 'Pena v. State' }]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, 1);
  assert.equal(cs.score, 1);
});

test('an unaccented gold caption matches an accented returned caption', async () => {
  const bc = mkCase('accent-returned', {
    kind: 'positive',
    tier: 'qualified',
    case_name: 'Pena v. State',
    gold_citations: [{ canonical_citation: 'AAA', alternates: [] }],
    avoid_citations: []
  });
  const pr = mkResult('accent-returned', [{ citation: 'AAA', title: 'Peña v. State' }]);
  const out = await scoreOne(bc, pr);
  const cs = out.caseScores[0];
  assert.equal(cs.hitRank, 1);
  assert.equal(cs.score, 1);
});

test('the wrong-name tokenizer treats accented and unaccented forms of a party as the same token', () => {
  // Query asks for the accented spelling; the returned caption carries the
  // unaccented one. Sharing the folded token means this is NOT wrong-named.
  const out = _internals.wrongNameFields([{ header: 'Pena v. State' }], 'Peña v. State');
  assert.equal(out.applicable, true);
  assert.equal(out.wrongCount, 0);
});

test('the wrong-name tokenizer still flags a genuinely unrelated result after folding', () => {
  const out = _internals.wrongNameFields([{ header: 'Smith v. Jones' }], 'Peña v. State');
  assert.equal(out.applicable, true);
  assert.equal(out.wrongCount, 1);
});
