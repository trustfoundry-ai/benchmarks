/**
 * Scorer for the trustfoundry-case-name-lookup suite.
 *
 * A hit is "a case with this name came back", not "the exact citation string
 * came back" -- case names are ambiguous (several distinct cases can share
 * the same parties), so scoring keys on the NORMALIZED CAPTION a row is
 * hunting for. See `captionHitRank`/`captionHitPredicate` for the match rule:
 * every axis matches by normalized equality except `single_party_search`,
 * whose query is a deliberate party-name fragment and matches by whole-token
 * containment instead (see the comment on `captionMatches`).
 *
 * Three scoring outcomes, keyed off `expected.kind`:
 *   - positive (any tier): hit@K / MRR against the target caption --
 *     `expected.case_name` for every axis except `single_party_search`,
 *     which targets the query text itself (`scoreCase` picks the target and
 *     the match mode together). `party_order_swap` rows also carry
 *     `orderPreference` (see `orderPreferenceFields`), a ranking claim that
 *     never changes `score`/`hitRank`.
 *   - negative: correct iff the provider returns zero results.
 *   - provider failure: `!providerResult || providerResult.status !== 'completed'`.
 *
 * Every scored row also gets `dedupedHitRank` and `distinctInTop5` (page-
 * quality diagnostics, never a scoring input -- see the comment above
 * `dedupedRankFields`) and, for positive rows, a `nameHitRank` diagnostic:
 * the first result whose title/header CONTAINS the normalized `case_name`,
 * looser than the headline's equality match. This is never the headline
 * score -- it separates "no case with this name came back at all" from "the
 * case came back, but under a caption only equality would reject" (e.g.
 * `Roe v. Wade, 410 U.S. 113` containing `Roe v. Wade`).
 *
 * Positive rows also carry `wrongName` (see `wrongNameFields`), an
 * independent metric answering a different question from recall: was the
 * page polluted with results sharing no distinctive party token with the
 * query, after dropping a stoplist of high-frequency caption tokens.
 * Aggregated as `summary.wrong_name` overall, and again as `wrong_name` on
 * each `by_axis[axis].perturbed`/`.control` arm (see `wrongNameRateFields`,
 * the one place the rate is computed), reported beside recall and never an
 * input to it -- a query whose every token is on the stoplist is excluded
 * from the rate and counted in `excluded_n`, not silently dropped, at every
 * level the rate is reported.
 */
import { validateScorerCutoffsMatchImplementation } from '@trustfoundry-ai/benchmarks-harness/core/scorer-validators';
import { wilsonInterval } from '@trustfoundry-ai/benchmarks-harness/core/stats';
import { defineScorerAdapter } from '@trustfoundry-ai/benchmarks-harness/contracts';

const SCORER_ID = 'trustfoundry-case-name-lookup';
// A published bundle records the scorer version that produced it. Any
// change to a metric's definition or to the summary's shape takes a new
// version, so `verifyResultBundle`'s re-score comparison fails loudly
// rather than silently diffing two incompatible definitions under one
// version string.
const VERSION = 'trustfoundry-case-name-lookup-v9';
const DEFAULT_CUTOFFS = [1, 3, 5, 10];
// hit@1 is the headline: the question is whether the top result carries the
// wanted case's name. hit@3/@5/@10 are reported beside it in `cutoffs` so the
// drop-off past the top slot is visible, but none of them decide the run.
const DEFAULT_HEADLINE_CUTOFF = 1;
const MRR_DECIMAL_PLACES = 4;

// ---- helpers mirrored unchanged from citation-lookup.mjs ----

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function envelopeResults(envelope) {
  if (!envelope) return [];
  if (Array.isArray(envelope.results)) return envelope.results;
  if (Array.isArray(envelope.search_results)) return envelope.search_results;
  return [];
}

function latencyMs(providerResult) {
  const duration = providerResult?.timing?.durationMs;
  return Number.isFinite(duration) ? duration : null;
}

function hitAtFields(hitRank, cutoffs) {
  const out = {};
  for (const k of cutoffs) {
    out[`hitAt${k}`] = hitRank !== null && hitRank <= k;
  }
  return out;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * (pct / 100);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function truncateDecimal(value, decimalPlaces) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimalPlaces;
  return Math.trunc(value * factor) / factor;
}

function groupBy(cases, key) {
  const groups = {};
  for (const c of cases) {
    const value = c[key] ?? '<unknown>';
    (groups[value] ??= []).push(c);
  }
  return groups;
}

function latencySummary(cases) {
  const values = cases.map((c) => c.latencyMs).filter((v) => Number.isFinite(v));
  if (!values.length) return { n: 0, min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  return {
    n: values.length,
    min: Math.min(...values),
    mean: mean(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values)
  };
}

// ---- name-based diagnostic ----

// A caption differing only by an accent is the same case name -- comparing
// `Peña v. State` against `Pena v. State` as unequal measures the corpus's
// storage form for that caption, not whether the backend retrieved the case.
// NFD decomposes a precomposed accented letter into its base letter plus a
// combining mark (U+0300-U+036F, the Combining Diacritical Marks block),
// which the second replace then strips, so `peña` and `pena` fold to the
// same token. This is diacritic folding, not ligature folding: NFD does not
// decompose a ligature into its component letters, so `æ`/`œ` pass through
// unchanged either way.
function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length ? normalized : null;
}

function nameHitRank(results, caseName) {
  const target = normalizeName(caseName);
  if (!target) return null;
  for (const [index, result] of results.entries()) {
    const candidates = [normalizeName(result?.title), normalizeName(result?.header)].filter(Boolean);
    if (candidates.some((candidate) => candidate.includes(target))) {
      return Number.isInteger(result?.rank) && result.rank > 0 ? result.rank : index + 1;
    }
  }
  return null;
}

// A hit is "a case with this name came back". Equality, not containment:
// containment lets gold `Smith v. Jones` match a returned
// `Smith v. Jones Manufacturing Co.`, which is a different company. Equality
// has no over-matching failure mode to explain, which is why it is the
// default for every axis whose query is a full case name.
//
// `single_party_search` is the one axis whose query is a deliberate fragment
// (a bare party name) rather than a full caption, so it cannot use equality
// at all -- `Corcoran` can never equal `Corcoran v. State`. It uses `match:
// 'contains'` instead: every normalized token of the query must appear as
// its own whole token in the caption. Whole-token, not raw substring --
// `includes` would credit `Brown` for `Browning v. State`, which is exactly
// the over-matching equality was chosen elsewhere to avoid. Whole-token
// containment is the tightest match available once equality is off the
// table.
// Single tokenization primitive for every consumer that needs a normalized
// name's token set. `containsAllTokens`'s whole-token containment and
// `distinctiveTokens`'s stoplist filter (below) both split the SAME way, so
// the wrong-name detector can never quietly diverge from the hit-matching
// tokenizer it is built alongside -- two independent splitters that can drift
// apart is exactly the "detector reimplements the generator" failure shape
// this file guards against elsewhere (see the comment on
// `orderPreferenceFields`).
function nameTokens(normalized) {
  return normalized.split(' ');
}

function containsAllTokens(caption, wanted) {
  const captionTokens = new Set(nameTokens(caption));
  return nameTokens(wanted).every((token) => captionTokens.has(token));
}

function captionMatches(caption, wanted, match) {
  if (match === 'equals') return caption === wanted;
  if (match === 'contains') return containsAllTokens(caption, wanted);
  // Fail loudly on an unrecognized match mode rather than let a typo
  // silently read as `equals`.
  throw new Error(`captionHitRank: unrecognized match mode "${match}"`);
}

// One predicate, built once and shared by both the rank search below and
// `dedupedRankFields`'s slot-by-slot walk in `scoreCase`. Sharing it is what
// keeps `hitRank` and `dedupedHitRank` describing the same hit, jurisdiction
// guard included: two independently written copies of "does this result
// count as a hit" is exactly the shape of bug where one copy's guard fails to
// reach the other path.
function captionHitPredicate(target, { jurisdiction = null, match = 'equals' } = {}) {
  const wanted = normalizeName(target);
  if (!wanted) return () => false;
  return (result) => {
    // The request already filters by jurisdiction, so this should never fire.
    // It is asserted rather than assumed: a provider that ignores the filter
    // must show up in the numbers, not benefit from a wider pool. Case-folded
    // because the two sides are not case-aligned in this repo's own data --
    // `geo_level_2_identifier` is lowercase, `second_level_geo` comes back
    // upper -- and a case-sensitive compare would fire on every
    // in-jurisdiction result instead of only the ones that actually violate
    // the filter.
    if (
      jurisdiction &&
      result?.second_level_geo &&
      result.second_level_geo.toLowerCase() !== jurisdiction.toLowerCase()
    ) {
      return false;
    }
    const captions = [normalizeName(result?.title), normalizeName(result?.header)].filter(Boolean);
    return captions.some((caption) => captionMatches(caption, wanted, match));
  };
}

function firstMatchRank(results, isHit) {
  for (const [index, result] of results.entries()) {
    if (isHit(result)) {
      return Number.isInteger(result?.rank) && result.rank > 0 ? result.rank : index + 1;
    }
  }
  return null;
}

function captionHitRank(results, target, options = {}) {
  return firstMatchRank(results, captionHitPredicate(target, options));
}

// ---- wrong-name rate (independent metric, never a scoring input) ----
//
// Recall (above) answers "did a case with the right name come back". This
// answers a different question: was the page polluted with results whose
// names have nothing to do with what was asked. `Roe v. Wade` returned for
// the query `brown` is the failure; `Brown v. United States` is not --
// returning *some* Brown is the expected behaviour of an ambiguous name
// lookup, not pollution. Reported beside recall in `summary.wrong_name`,
// never mixed into it.

// High-frequency caption tokens carry no identifying signal: nearly every
// criminal caption contains `state`, so sharing one says nothing about
// whether a result relates to the query.
const NAME_STOPLIST = new Set([
  'v', 'vs', 'versus', 'in', 're', 'ex', 'rel', 'the', 'of', 'and',
  'state', 'states', 'united', 'commonwealth', 'people', 'city', 'county',
  'inc', 'co', 'corp', 'llc', 'ltd', 'company'
]);

function distinctiveTokens(value) {
  const normalized = normalizeName(value);
  if (!normalized) return new Set();
  return new Set(nameTokens(normalized).filter((t) => t && !NAME_STOPLIST.has(t)));
}

// "Did the page contain names that have nothing to do with what was asked?"
// A result is inconsistent with the query when it shares no distinctive
// token with it, after the stoplist above drops the tokens too common to
// carry any identifying signal.
function wrongNameFields(results, queryText) {
  const wanted = distinctiveTokens(queryText);
  // A query whose every token is on the stoplist (a case genuinely captioned
  // `State`) leaves nothing distinctive to match on. Scoring it would report
  // a 100% wrong-name rate for a query that cannot discriminate at all, so it
  // is excluded from the rate -- and the exclusion is counted here, never
  // silent, so a rate computed over an unstated subset can never read as a
  // rate over everything.
  if (!wanted.size) return { applicable: false, wrongCount: 0, resultCount: results.length };
  let wrongCount = 0;
  for (const result of results) {
    const got = new Set([
      ...distinctiveTokens(result?.title),
      ...distinctiveTokens(result?.header)
    ]);
    if (![...wanted].some((token) => got.has(token))) wrongCount += 1;
  }
  return { applicable: true, wrongCount, resultCount: results.length };
}

// One shape, one definition, for every place the wrong-name rate is
// reported -- the overall `summary.wrong_name` and each `by_axis[axis]`
// arm both call this rather than each re-deriving the arithmetic. A rate
// over returned results, plus `applicable_n` and `excluded_n`: the
// exclusion is counted at every level the rate is reported, never folded
// silently into "computed over everything."
function wrongNameRateFields(cases) {
  const applicable = cases.filter((c) => c.wrongName?.applicable);
  const totalResults = applicable.reduce((sum, c) => sum + c.wrongName.resultCount, 0);
  const wrongResults = applicable.reduce((sum, c) => sum + c.wrongName.wrongCount, 0);
  return {
    rate: totalResults ? wrongResults / totalResults : 0,
    applicable_n: applicable.length,
    excluded_n: cases.length - applicable.length
  };
}

// ---- order preference (party_order_swap only, never a scoring input) ----
//
// `party_order_swap` is scored as ordinary recall: querying `B v. A` should
// still surface `A v. B`, so the gold document is unchanged and `score`/
// `hitRank` follow the same caption rule as every other axis (see
// `scoreCase`). What this reports instead is a separate RANKING claim: if a
// real `B v. A` document ALSO exists in the corpus, it should outrank
// `A v. B`. Rows where no reversal appears do not exercise the claim and can
// never fail it -- `exercised` makes that visible rather than silently
// passing.
//
// Excludes the gold row by CAPTION, not by citation: for a `B v. A` query the
// gold is `A v. B`, and we are hunting a separate result whose caption is the
// reversed form the user typed. A slot whose `title` OR `header` reads as the
// gold caption can never be the reversal, even if its OTHER field happens to
// read as the swapped text -- a real corpus data artifact where one field on
// a single document disagrees with the other. Treating that slot as a
// competing case would fabricate an exercised assertion out of one document.
//
// The reversed caption is matched against the QUERY TEXT, not against a
// party-swap reimplemented here in JS. The query already IS the swapped name
// by construction, and re-deriving it would let the detector reimplement the
// generator -- the two could drift and the assertion would quietly stop
// matching what was generated.
//
// Matches by exact caption EQUALITY, not containment. Containment admits a
// THIRD case whose caption merely contains the typed one: querying
// `Womack-Grey v. State` for gold `State v. Womack-Grey` can match
// `State ex rel. Womack-Grey v. State` at a later rank, which is a different
// case, not the reversal, and would misreport a ranking violation the gold
// document did not commit. The spec's claim is about `B v. A` being *in the
// corpus*, so the caption has to BE the typed name.
//
// The cost of the tighter reading, carried openly: a corpus that stores the
// reversal with a suffix (`B v. A, Inc.`) does not exercise the assertion.
// Under-exercising is the safe direction -- it can miss a real violation but
// it can never fabricate one, and the exercised count stays visible in every
// summary that reports this field.
function orderPreferenceFields({ nameTransform, queryText, results, goldCaption, originalRank }) {
  if (nameTransform !== 'party_order_swap') return null;
  const gold = normalizeName(goldCaption);
  const target = normalizeName(queryText);
  let reversedRank = null;
  if (target) {
    for (const [index, result] of results.entries()) {
      const captions = [normalizeName(result?.title), normalizeName(result?.header)].filter(Boolean);
      if (gold && captions.some((caption) => caption === gold)) continue; // the gold itself
      if (captions.some((caption) => caption === target)) {
        reversedRank = Number.isInteger(result?.rank) && result.rank > 0 ? result.rank : index + 1;
        break;
      }
    }
  }
  const exercised = reversedRank !== null && originalRank !== null;
  return { exercised, reversedRank, originalRank, satisfied: exercised ? reversedRank < originalRank : null };
}

// ---- caption dedup (page-quality diagnostic, never a scoring input) ----
//
// A case-name page can show the same case at several ranks under
// near-duplicate captions -- headers that differ only in case or minor
// formatting, which `normalizeName` folds together. A provider that
// retrieved the right case can still miss a strict rank cutoff purely
// because of that repetition, not retrieval quality. `dedupedHitRank` and
// `distinctInTop5` describe how deep a user had to look past *repeated*
// captions, reusing `normalizeName` so dedup and name-matching can never
// disagree about what counts as "the same" caption. Both are computed off
// array position (page slot), not the provider's self-reported `rank`
// field -- unlike `hitRank`, which honors a provider-supplied `rank` when it
// is a positive integer. This is deliberate (dedup describes
// the page as actually laid out, slot by slot), but it means `dedupedHitRank`
// and `hitRank` read off different sources of truth and can, in principle,
// disagree if a provider's self-reported `rank` does not match its result's
// array position (e.g. several results all claiming `rank: 1`). The one live
// provider always sets `rank: index + 1` (verified slot-aligned across a
// real 100-result run), so this is latent, not observed. It is deliberately
// NOT clamped to `hitRank` here: `dedupedHitRank` is answering "how many
// distinct entries does the page actually show before this one", and
// silently substituting a smaller value borrowed from a different (and, in
// this hypothetical, wrong) rank source would misreport that question
// rather than fix it.

function captionKey(result) {
  return normalizeName(result?.header ?? result?.title ?? '');
}

// Distinct captions among the first 5 *result slots* -- NOT the first 5
// distinct captions ever seen. Those differ whenever duplicates crowd the
// front of the page: 10 results whose first 5 slots share one caption must
// report 1, not 5.
function distinctCaptionCount(results) {
  const seen = new Set();
  for (const result of results.slice(0, 5)) {
    const key = captionKey(result);
    if (key) seen.add(key);
  }
  return seen.size;
}

// `isGoldHit(index)` reports whether `results[index]` matches the target
// caption, under the same predicate `hitRank` is built from (`hitPredicate`
// in `scoreCase`). `dedupedHitRank` is the count of distinct entries seen by
// page slot, up to and including the first slot `isGoldHit` accepts -- null
// if no slot does.
//
// An uncaptioned slot (both `header` and `title` missing/blank) still counts
// as its own distinct entry: it is a result the user sees and cannot tell
// apart from any OTHER uncaptioned slot, so it is not "the same" as one seen
// before -- it is unlabelled, not a duplicate. Counting every uncaptioned
// slot as distinct keeps `dedupedHitRank` a running count of
// slots-inspected-so-far (collapsing only *repeated, identifiable*
// captions), which is never `0` for any slot that has been reached, so a
// real hit can never misread as `dedupedHitRank: null` ("not found") once a
// hit is found at or before it -- dedup must never change whether a row
// counts as a hit.
function dedupedRankFields(results, isGoldHit) {
  const seenKeys = new Set();
  let distinctCount = 0;
  let dedupedHitRank = null;
  for (let i = 0; i < results.length; i += 1) {
    const key = captionKey(results[i]);
    if (key) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        distinctCount += 1;
      }
    } else {
      distinctCount += 1;
    }
    if (dedupedHitRank === null && isGoldHit(i)) dedupedHitRank = distinctCount;
  }
  return { dedupedHitRank, distinctInTop5: distinctCaptionCount(results) };
}

// ---- per-case scoring ----

function scoreCase({ benchmarkCase, providerResult, cutoffs, headlineCutoff }) {
  const expected = benchmarkCase.metadata?.expected ?? {};
  const kind = expected.kind ?? 'positive';
  // Only 'positive' and 'negative' are recognized. `buildSummary` sorts
  // scored rows into `positives`/`negatives` by exact kind match -- a row
  // with any other kind would fall through to the positive-scoring branch
  // below, score successfully, and then land in NEITHER bucket, contributing
  // to no aggregate at all. That silent loss is precisely the failure class
  // this suite exists to prevent, so an unrecognized kind fails loudly here
  // instead of scoring quietly into nothing.
  if (kind !== 'positive' && kind !== 'negative') {
    const caseId = benchmarkCase.caseId ?? '<unknown caseId>';
    const rowIndex = benchmarkCase.metadata?.datasetIndex ?? '<unknown rowIndex>';
    throw new Error(
      `trustfoundry-case-name-lookup scoreCase: unrecognized kind "${kind}" on caseId=${caseId} rowIndex=${rowIndex}`
    );
  }
  // Fall back to `expected.*`. A LIVE run carries these mirrored at the metadata
  // top level; a run RECONSTRUCTED from a published bundle only has them inside
  // `expected`, because that is the block the raw-row schema publishes. Reading
  // both is what lets a published bundle re-score to the same numbers.
  const tier = benchmarkCase.metadata?.tier ?? expected.tier ?? null;
  const nameTransform =
    benchmarkCase.metadata?.name_transform ?? expected.name_transform ?? null;
  const negativeCategory =
    benchmarkCase.metadata?.negative_category ?? expected.negative_category ?? null;
  // Fail-safe direction: an undefined/missing flag must count TOWARD the
  // headline (synthetic === false), never silently out of it. Only an
  // explicit `true` (set by the dataset for its synthetic axes) excludes a row.
  const synthetic = expected.synthetic === true;
  // Every row carries `arm` ('perturbed' or 'control'); the headline (below,
  // in `buildSummary`) is computed over the perturbed arm only, with each
  // axis's paired control arm reported separately (see `by_axis`) rather
  // than folded into the headline. `?? 'perturbed'` is a fail-safe default
  // for a row that is missing the field, not the common case.
  const arm = expected.arm ?? 'perturbed';

  const base = {
    caseId: benchmarkCase.caseId,
    rowIndex: benchmarkCase.metadata?.datasetIndex ?? null,
    kind,
    tier,
    nameTransform,
    synthetic,
    negativeCategory,
    negative: kind === 'negative',
    arm,
    providerStatus: providerResult?.status ?? 'missing'
  };

  if (!providerResult || providerResult.status !== 'completed') {
    return {
      ...base,
      status: 'provider_failure',
      score: 0,
      hitRank: null,
      ...hitAtFields(null, cutoffs),
      dedupedHitRank: null,
      // `null`, not `0`: `results` is never parsed on this branch (the
      // provider errored or timed out), so there is nothing measured to
      // report. A hardcoded `0` here would read identically to a genuinely
      // empty, successfully-returned page and silently poison any mean
      // computed over this field.
      distinctInTop5: null,
      reciprocalRank: 0,
      resultCount: 0,
      falsePositive: false,
      nameHitRank: null,
      nameHitAt1: false,
      nameHitAt5: false,
      // Same reasoning as `distinctInTop5` above: `results` is never parsed
      // on this branch, so there is nothing to report a wrong-name rate over.
      wrongName: null,
      latencyMs: latencyMs(providerResult),
      error: providerResult?.error ?? null
    };
  }

  const envelope = safeParse(providerResult.finalOutputText) ?? {};
  const results = envelopeResults(envelope);
  const resultCount = results.length;

  if (kind === 'negative') {
    const isEmpty = resultCount === 0;
    return {
      ...base,
      status: 'scored',
      score: isEmpty ? 1 : 0,
      hitRank: null,
      ...hitAtFields(null, cutoffs),
      dedupedHitRank: null,
      distinctInTop5: distinctCaptionCount(results),
      reciprocalRank: 0,
      resultCount,
      falsePositive: !isEmpty,
      nameHitRank: null,
      nameHitAt1: false,
      nameHitAt5: false,
      // Negative rows measure empty-on-nonsense, a different question --
      // `buildSummary` never aggregates the wrong-name rate over this kind.
      wrongName: null,
      latencyMs: latencyMs(providerResult),
      error: null
    };
  }

  // positive (any tier)
  const nHitRank = nameHitRank(results, expected.case_name);
  // Against the QUERY TEXT the caller actually typed, not against gold --
  // this is measuring page pollution relative to what was asked, which is a
  // question about the query, not about which case the axis happens to be
  // hunting.
  const wrongName = wrongNameFields(results, benchmarkCase.prompt);

  // `single_party_search` is the ONE axis whose query is a deliberate fragment,
  // so it compares against the QUERY. Every other axis compares against gold.
  // `arm` was already resolved onto `base` above; reuse it here.
  const isPartySearch = nameTransform === PARTY_SEARCH_AXIS && arm === 'perturbed';
  const target = isPartySearch ? benchmarkCase.prompt : expected.case_name;
  // Same `metadata` top-level / `expected` fallback as `tier` and friends
  // above: a live run mirrors this at the metadata top level, a run
  // reconstructed from a published bundle only has it inside `expected`.
  const jurisdiction =
    benchmarkCase.metadata?.geo_level_2_identifier ?? expected.geo_level_2_identifier ?? null;
  // See the comment on `captionHitRank`: the fragment axis matches by
  // whole-token containment, every other axis by equality.
  const match = isPartySearch ? 'contains' : 'equals';
  // Built once and shared by both reads below -- `hitRank` and
  // `dedupedHitRank` must agree on what counts as a hit (jurisdiction guard
  // included), or the deduped column stops describing the same hit.
  const hitPredicate = captionHitPredicate(target, { jurisdiction, match });
  const hitRank = firstMatchRank(results, hitPredicate);
  const isHitAt = (index) => hitPredicate(results[index]);
  const { dedupedHitRank, distinctInTop5 } = dedupedRankFields(results, isHitAt);

  const orderPreference = orderPreferenceFields({
    nameTransform,
    queryText: benchmarkCase.prompt,
    results,
    goldCaption: expected.case_name,
    originalRank: hitRank
  });

  return {
    ...base,
    status: 'scored',
    score: hitRank !== null && hitRank <= headlineCutoff ? 1 : 0,
    hitRank,
    ...hitAtFields(hitRank, cutoffs),
    dedupedHitRank,
    distinctInTop5,
    orderPreference,
    reciprocalRank: hitRank ? 1 / hitRank : 0,
    resultCount,
    falsePositive: false,
    nameHitRank: nHitRank,
    nameHitAt1: nHitRank !== null && nHitRank <= 1,
    nameHitAt5: nHitRank !== null && nHitRank <= 5,
    wrongName,
    latencyMs: latencyMs(providerResult),
    error: null
  };
}

// ---- Macro-averaged headline (v2) ----
//
// `wilsonInterval`/`Z95` live in `core/stats.mjs` -- a category with no rows
// getting the full unit interval (see that module) is what
// `category_coverage` below is reporting as a MISSING measurement, not a
// confident one.

// The one category scored by name rather than by citation. See scoreCase.
const PARTY_SEARCH_AXIS = 'single_party_search';

// THE PUBLISHED NUMBER: the macro-average of hit@K across every category.
//
// Macro-average equals the pooled rate exactly when every category carries
// the same row count -- so under equal allocation there is no methodological
// choice to defend and no way to move the headline by re-weighting. Both are
// reported so an allocation drift shows up instead of hiding: a macro-average
// alone would keep looking reasonable while the equal-allocation property it
// rests on quietly stopped holding, whereas macro and pooled parting ways
// makes that drift visible immediately.
//
// Every category counts equally, by name, with no category excluded from
// this computation -- excluding one would break macro == pooled under equal
// allocation, and would be a per-category carve-out this scorer does not
// otherwise make.
function macroHeadline(byAxis, cutoff) {
  const perCategory = {};
  for (const key of Object.keys(byAxis).sort()) {
    const entry = byAxis[key];
    const n = entry?.n ?? 0;
    const rate = entry?.hit_at?.[`hit@${cutoff}`] ?? 0;
    perCategory[key] = { n, [`hit@${cutoff}`]: rate, ci95: wilsonInterval(Math.round(rate * n), n) };
  }
  const rates = Object.values(perCategory).map((e) => e[`hit@${cutoff}`]);
  const totalN = Object.values(perCategory).reduce((sum, e) => sum + e.n, 0);
  const hits = Object.values(perCategory).reduce((sum, e) => sum + e[`hit@${cutoff}`] * e.n, 0);
  const macro = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  return {
    metric: `macro_hit_at_${cutoff}`,
    macro,
    pooled: totalN ? hits / totalN : 0,
    n_categories: rates.length,
    n_rows: totalN,
    ci95: wilsonInterval(Math.round(macro * totalN), totalN),
    per_category: perCategory
  };
}

// ---- aggregation ----

function aggregatePositives(cases, cutoffs) {
  const n = cases.length;
  const hitAt = {};
  // Deduped alongside raw: same shape, same cutoffs, computed off
  // `dedupedHitRank` instead of `hitRank`. Page-quality view of the same
  // ranking -- never a substitute for `hit_at`, always reported beside it.
  const dedupedHitAt = {};
  for (const cutoff of cutoffs) {
    hitAt[`hit@${cutoff}`] = n
      ? cases.filter((c) => c.hitRank !== null && c.hitRank <= cutoff).length / n
      : 0;
    dedupedHitAt[`hit@${cutoff}`] = n
      ? cases.filter((c) => c.dedupedHitRank !== null && c.dedupedHitRank <= cutoff).length / n
      : 0;
  }
  return {
    n,
    hit_at: hitAt,
    deduped_hit_at: dedupedHitAt,
    mrr: n
      ? truncateDecimal(
          cases.reduce((sum, c) => sum + c.reciprocalRank, 0) / n,
          MRR_DECIMAL_PLACES
        )
      : 0
  };
}

function nameHitAtSummary(cases) {
  const n = cases.length;
  return {
    'name_hit@1': n ? truncateDecimal(cases.filter((c) => c.nameHitAt1).length / n, MRR_DECIMAL_PLACES) : 0,
    'name_hit@5': n ? truncateDecimal(cases.filter((c) => c.nameHitAt5).length / n, MRR_DECIMAL_PLACES) : 0
  };
}

// by_tier: hit_at + mrr for every tier, plus the name-hit containment
// diagnostic for the ambiguous tier specifically: ambiguity is exactly the
// case where "did a case with this name come back at all" is a more useful
// question than the headline's stricter equality match.
//
// `synthetic` rows (single_party_caption, latin_extended_inject -- flagged
// `synthetic: true` by the dataset) are excluded from each tier's headline hit_at/mrr:
// their query shape is not one a real user produces, so a headline computed
// over them would be measuring a rewrite no one performs. The inclusive
// figure over every row (synthetic included) is still published, nested as
// `all_axes`, so nothing is silently dropped -- only kept out of the number
// the tier is judged on. by_axis (below) reports the synthetic axis's own
// rate regardless.
function buildTierSummary(positives, cutoffs) {
  const out = {};
  for (const [tier, bucket] of Object.entries(groupBy(positives, 'tier'))) {
    const headlineBucket = bucket.filter((c) => !c.synthetic);
    const base = aggregatePositives(headlineBucket, cutoffs);
    const allAxes = aggregatePositives(bucket, cutoffs);
    out[tier] =
      tier === 'ambiguous'
        ? { ...base, name_hit_at: nameHitAtSummary(bucket), all_axes: allAxes }
        : { ...base, all_axes: allAxes };
  }
  return out;
}

// by_axis: keyed by name_transform. Every positive row carries a real
// transform name -- `clean` is the paired control arm, distinguished by
// `arm`, not an absent transform -- so a null here can only mean a row that
// should never have reached this scorer. Bucketing it under an invented key
// would merge it into whichever axis the fallback picked, silently changing
// that axis's denominator: the by_axis figures feed a macro-average that is
// un-gameable only because every category's denominator is exactly what the
// dataset put there. Fail loudly instead, the same way `scoreCase` fails
// loudly on an unrecognized `kind` rather than scoring a row into no
// aggregate at all.
//
// Each axis reports its own paired control alongside the perturbed arm:
// every case has a clean form, so a perturbed row and its control are the
// SAME case, and the difference between the two isolates the perturbation
// instead of mixing in how ambiguous that case's captions happen to be --
// the confound a comparison ACROSS axes (e.g. country_form vs. clean) can't
// avoid, because those are disjoint cases carrying different amounts of
// ambiguity to begin with.
function buildAxisSummary(positives, cutoffs) {
  const out = {};
  const groups = {};
  for (const c of positives) {
    if (c.nameTransform == null) {
      const caseId = c.caseId ?? '<unknown caseId>';
      const rowIndex = c.rowIndex ?? '<unknown rowIndex>';
      throw new Error(
        `trustfoundry-case-name-lookup buildAxisSummary: positive row has no name_transform, caseId=${caseId} rowIndex=${rowIndex}`
      );
    }
    const key = c.nameTransform;
    (groups[key] ??= { perturbed: [], control: [] })[c.arm ?? 'perturbed'].push(c);
  }
  for (const [key, arms] of Object.entries(groups)) {
    // wrong_name rides alongside hit_at/mrr on each arm -- same population
    // as the rest of that arm's aggregate (every row in the group, synthetic
    // included: by_axis is the exhaustive per-category view, not the
    // synthetic-excluded headline population `summary.wrong_name` uses).
    const perturbed = {
      ...aggregatePositives(arms.perturbed, cutoffs),
      wrong_name: wrongNameRateFields(arms.perturbed)
    };
    const controlAgg = aggregatePositives(arms.control, cutoffs);
    // `null`, not the zeros `aggregatePositives([])` would return: an empty
    // control arm means there is nothing to compare against, not that the
    // control arm scored 0.0. This keeps `by_axis` correct for any
    // category/axis that has no paired control rows.
    const control = arms.control.length
      ? { ...controlAgg, wrong_name: wrongNameRateFields(arms.control) }
      : null;
    const delta = {};
    for (const cutoff of cutoffs) {
      delta[`hit@${cutoff}`] = control
        ? perturbed.hit_at[`hit@${cutoff}`] - control.hit_at[`hit@${cutoff}`]
        : null;
    }
    out[key] = { perturbed, control, delta };
  }
  return out;
}

function aggregateNegatives(cases) {
  const n = cases.length;
  const fp = cases.filter((c) => c.falsePositive).length;
  // `n`, `fp_rate` and `correct_empty` describe the whole negative tier.
  // `by_category` breaks the same arithmetic down per category, because a
  // single pooled `fp_rate` cannot say WHICH near-miss shape a lowered
  // threshold breaks -- which is the question the near-miss tier exists to
  // answer.
  const byCategory = {};
  for (const c of cases) {
    const category = c.negativeCategory ?? 'uncategorized';
    const bucket = (byCategory[category] ??= { n: 0, fp: 0 });
    bucket.n += 1;
    if (c.falsePositive) bucket.fp += 1;
  }
  return {
    n,
    fp_rate: n ? truncateDecimal(fp / n, MRR_DECIMAL_PLACES) : 0,
    correct_empty: n - fp,
    by_category: Object.fromEntries(
      Object.entries(byCategory)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, { n: count, fp: fpCount }]) => [
          category,
          {
            n: count,
            fp_rate: count ? truncateDecimal(fpCount / count, MRR_DECIMAL_PLACES) : 0,
            correct_empty: count - fpCount
          }
        ])
    )
  };
}

function buildSummary(caseScores, { manifest, cutoffs, headlineCutoff }) {
  const scored = caseScores.filter((c) => c.status === 'scored');
  const positives = scored.filter((c) => c.kind === 'positive');
  const negatives = scored.filter((c) => c.kind === 'negative');
  const failed = caseScores.filter((c) => c.status !== 'scored' && c.status !== 'not_applicable');

  // Negative rows never reach `positives` -- they measure empty-on-nonsense,
  // a different question, and would dilute a recall-shaped headline; they
  // are aggregated separately as `negatives_overall` instead. Synthetic
  // rows (single_party_caption, latin_extended_inject) DO reach `positives`
  // but are excluded from the headline here: their query shape is not one a
  // real user produces (see the `synthetic` flag on `expected`). The
  // inclusive figure over every positive row, synthetic included, is still
  // published as `overall.all_axes` -- excluded from the denominator, never
  // dropped.
  // The headline is the perturbed arm only -- control rows are a reported
  // figure in their own right (see `by_axis`), never a headline input. Mixing
  // an easy control into the denominator would inflate the number that is
  // supposed to describe performance under name variation.
  const headlinePositives = positives.filter(
    (c) => !c.synthetic && (c.arm ?? 'perturbed') === 'perturbed'
  );
  const overall = {
    ...aggregatePositives(headlinePositives, cutoffs),
    all_axes: aggregatePositives(positives, cutoffs)
  };
  const headlineScore = overall.hit_at[`hit@${headlineCutoff}`] ?? 0;

  const total = caseScores.length;
  const summary = {
    total,
    scored: scored.length,
    positives: positives.length,
    negatives: negatives.length,
    providerFailures: failed.length,
    // A row that is neither scored nor a provider failure: the provider
    // completed normally but the row carries no pass/fail verdict. No kind
    // currently produces `status: 'not_applicable'`, so this reads 0 on
    // every current run -- kept so total === scored + providerFailures +
    // notApplicable always reconciles for any future status that lands
    // between "scored" and "failed" without a call site needing to know
    // which one.
    notApplicable: total - scored.length - failed.length,
    overallScore: headlineScore,
    supportedScore: headlineScore,
    mrr: overall.mrr,
    execution: {
      runId: manifest?.runId ?? manifest?.run_id ?? null,
      benchmark: manifest?.benchmark ?? null,
      provider: manifest?.provider ?? null,
      scheduler: manifest?.scheduler ?? null,
      scorer: {
        id: SCORER_ID,
        version: VERSION,
        cutoffs,
        headlineCutoff,
        mrrDecimalPlaces: MRR_DECIMAL_PLACES
      },
      caseCount: total
    },
    overall,
    by_tier: buildTierSummary(positives, cutoffs),
    by_axis: buildAxisSummary(positives, cutoffs),
    negatives_overall: aggregateNegatives(negatives),
    // Every row that produced a timed response has a real, finite latencyMs.
    // Filters on status rather than kind so a future not_applicable-style
    // status (see the `notApplicable` field above) is included automatically
    // instead of silently dropping out of the latency population.
    latency_ms: latencySummary(
      caseScores.filter((c) => c.status === 'scored' || c.status === 'not_applicable')
    )
  };
  // The published headline number, computed off `by_axis` so every category
  // is weighted equally regardless of how many rows each happens to carry.
  // `by_axis` entries are `{ perturbed, control, delta }` (paired control
  // aggregation); macroHeadline wants one aggregate per category, and the
  // headline is the perturbed arm only, so unwrap that arm here rather than
  // teaching macroHeadline about arms at all.
  const byAxis = summary.by_axis;
  const byAxisPerturbed = Object.fromEntries(
    Object.entries(byAxis).map(([key, arms]) => [key, arms.perturbed])
  );
  summary.headline = macroHeadline(byAxisPerturbed, headlineCutoff);

  // A rate over returned results, computed over the same headline population
  // as `overall` (positive, non-synthetic) but reported beside recall, never
  // folded into it -- see `wrongNameFields`/`wrongNameRateFields`.
  // `excluded_n` makes the stoplist-only exclusion visible rather than
  // letting the rate silently read as computed over every row.
  summary.wrong_name = wrongNameRateFields(headlinePositives);

  for (const k of cutoffs) {
    summary[`hitAt${k}`] = overall.hit_at[`hit@${k}`];
    summary[`dedupedHitAt${k}`] = overall.deduped_hit_at[`hit@${k}`];
  }
  return summary;
}

function resolveSettings({ manifest, config } = {}) {
  const source = config ?? manifest?.scorer?.settings ?? manifest?.scorer?.config ?? {};
  const rawCutoffs = source?.cutoffs;
  const cutoffs = Array.isArray(rawCutoffs) && rawCutoffs.length > 0
    ? Array.from(new Set(rawCutoffs.map(Number).filter((n) => Number.isFinite(n) && n > 0)))
        .sort((a, b) => a - b)
    : DEFAULT_CUTOFFS;
  const rawHeadline = source?.headline_cutoff ?? source?.headlineCutoff;
  const parsed = Number.parseInt(String(rawHeadline ?? ''), 10);
  const headlineCutoff = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEADLINE_CUTOFF;
  return { cutoffs, headlineCutoff };
}

function finalize({ manifest, caseScores, cutoffs, headlineCutoff }) {
  return {
    scorerId: SCORER_ID,
    status: 'completed',
    caseScores,
    summary: buildSummary(caseScores, { manifest, cutoffs, headlineCutoff }),
    metadata: {
      scorer: SCORER_ID,
      version: VERSION,
      cutoffs,
      headlineCutoff,
      mrrDecimalPlaces: MRR_DECIMAL_PLACES
    }
  };
}

export const caseNameLookupScorerAdapter = defineScorerAdapter({
  id: SCORER_ID,
  version: VERSION,
  SUPPORTED_CUTOFFS: DEFAULT_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF: DEFAULT_HEADLINE_CUTOFF,

  validateConfig({ scorerConfig }) {
    validateScorerCutoffsMatchImplementation(scorerConfig ?? {}, {
      supportedCutoffs: DEFAULT_CUTOFFS,
      supportedHeadlineCutoff: DEFAULT_HEADLINE_CUTOFF,
      scorerId: this.id
    });
  },

  async describe() {
    return {
      id: this.id,
      version: this.version,
      notes:
        'Case-name-lookup scoring. A hit is a case with this name coming ' +
        'back, not the exact citation string -- hitRank is the rank of the ' +
        'first result whose caption matches the target caption (equality ' +
        'for every axis except single_party_search, which matches by ' +
        'whole-token containment against the query fragment). ' +
        'party_order_swap rows also carry orderPreference, a ranking claim ' +
        'that never changes score or hitRank. Negative rows (kind=negative) ' +
        'are correct iff the provider returns zero results. A ' +
        'containment-based nameHitRank diagnostic (never the headline) ' +
        'separates "no case with this name came back at all" from "the ' +
        'case came back under a caption only equality would reject". ' +
        'summary.wrong_name reports an independent rate: the share of ' +
        'returned results sharing no distinctive party token with the ' +
        'query, over the headline population, with excluded_n counting ' +
        'queries whose every token is too common to discriminate. The same ' +
        'rate is reported again on each by_axis[axis].perturbed/.control ' +
        'arm, with its own applicable_n and excluded_n.'
    };
  },

  async score({ manifest, cases, providerResults, config }) {
    const { cutoffs, headlineCutoff } = resolveSettings({ manifest, config });
    const byCaseId = new Map(providerResults.map((r) => [r.caseId, r]));
    const caseScores = cases.map((c) =>
      scoreCase({
        benchmarkCase: c,
        providerResult: byCaseId.get(c.caseId),
        cutoffs,
        headlineCutoff
      })
    );
    return finalize({ manifest, caseScores, cutoffs, headlineCutoff });
  },

  async scoreStream({ manifest, pairs, onCaseScored, config }) {
    const { cutoffs, headlineCutoff } = resolveSettings({ manifest, config });
    const caseScores = [];
    for await (const pair of pairs) {
      const benchmarkCase = pair.benchmarkCase ?? pair[0];
      const providerResult = pair.providerResult ?? pair[1];
      const caseScore = scoreCase({
        benchmarkCase,
        providerResult,
        cutoffs,
        headlineCutoff
      });
      caseScores.push(caseScore);
      if (onCaseScored) {
        await onCaseScored({ benchmarkCase, providerResult, caseScore });
      }
    }
    return finalize({ manifest, caseScores, cutoffs, headlineCutoff });
  }
});

export const SUPPORTED_CUTOFFS = DEFAULT_CUTOFFS;
export const SUPPORTED_HEADLINE_CUTOFF = DEFAULT_HEADLINE_CUTOFF;

export const _internals = {
  scoreCase,
  envelopeResults,
  wilsonInterval,
  macroHeadline,
  nameHitRank,
  captionHitRank,
  normalizeName,
  NAME_STOPLIST,
  wrongNameFields,
  wrongNameRateFields,
  captionKey,
  distinctCaptionCount,
  dedupedRankFields,
  aggregatePositives,
  aggregateNegatives,
  buildTierSummary,
  buildAxisSummary,
  buildSummary,
  resolveSettings
};
