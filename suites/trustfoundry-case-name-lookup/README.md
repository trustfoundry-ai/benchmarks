# TrustFoundry Case-Name Lookup

This suite measures a single question: **a user knows the name of a case but not its
citation — does the search backend put that case in front of them?**

It is a different question from the one the `trustfoundry-legal-search` suite asks.
There the query is a question about the law and the expected document is whatever best
answers it. Here the query *is* the document's name, possibly mistyped, abbreviated,
reordered, or reduced to a single party, and the expected document is the one case that
name belongs to. A backend can be excellent at the first and useless at the second.

The suite is provider-agnostic. Any provider adapter registered in the harness can run
against these datasets, and results are comparable across providers because every run
uses the same rows, the same scorer, and the same cutoffs.

## The cost ratio this benchmark is built around

**A wrong case on the page is acceptable. Returning nothing is worse.**

That is a product judgement, and it is stated here because it decides how the numbers
should be read. A backend that suppresses uncertain answers to protect precision will
look good on any hit-rate metric and be worse to use: the corpus holds the case, the
user typed its name, and the product said nothing. So this suite reports a
**wrong-name rate beside the hit rate**, and reports a **false-positive rate on invented
case names** so the cost of answering loosely is priced rather than assumed.

Neither the hit rate nor the false-positive rate carries a pass/fail threshold.
Thresholds are set after a baseline exists, not before.

## Provider options

| Adapter | What it is | Setup + run | Config |
|---|---|---|---|
| `trustfoundry-legal-search` with `model_type: case_name` | TrustFoundry public search API, dedicated case-name lane — the canonical baseline for this suite | [`docs/adapters/trustfoundry-legal-search.md`](../../docs/adapters/trustfoundry-legal-search.md#trustfoundry-case-name-lookup-lane-model_type-case_name) | [`trustfoundry-case-name-lookup.json`](../../configs/providers/trustfoundry-case-name-lookup.json) |

The provider sends `query_text` verbatim as `query`, forwards the row's jurisdiction as
`state`, and reads back the ranked page. `state` is required: the API rejects a
`case_name` request without one, exactly as it does for the four question-shaped model
types.

## Datasets

Two datasets, both shipped as JSONL. The published set is the recall population; the
negatives set is the invariant population that prices what answering loosely costs.

| Dataset | Rows | What it is | Config |
|---|---|---|---|
| [`v2-public.jsonl`](../../data/trustfoundry-case-name-lookup/v2-public.jsonl) | **8,850** | 15 categories × 295 paired cases (one perturbed row + one control row per case) | [`v2-public.json`](../../configs/benchmarks/trustfoundry-case-name-lookup/v2-public.json) |
| [`v2-negatives.jsonl`](../../data/trustfoundry-case-name-lookup/v2-negatives.jsonl) | 50 | Invented case names that resolve to no document | [`v2-negatives.json`](../../configs/benchmarks/trustfoundry-case-name-lookup/v2-negatives.json) |

### The paired design

Every gold case in the published set is queried twice: once under its perturbed
caption (`arm: perturbed`) and once under the caption exactly as the corpus stores it
(`arm: control`). The two rows share a `pair_id` and target the same underlying case.

This is why the per-category numbers are trustworthy. A category's score is not
compared against a single global baseline — it is compared against the *same 295
cases*, queried cleanly. Without that, a category's score would mix two things that
have nothing to do with each other: how much the perturbation actually hurt retrieval,
and how hard that category's particular sample of cases happens to be regardless of any
perturbation. A category built from an unusually ambiguous slice of the corpus would
look like a retrieval failure even if the perturbation itself cost nothing. Pairing
separates those two effects: `delta = perturbed hit@1 − control hit@1` is the
perturbation's own effect, holding the case sample fixed.

### How the published set is built

Gold captions are drawn from CourtListener case names held in TrustFoundry's document
store. A pair is one gold case, queried once perturbed and once as its own control.

- **8,850 rows, 4,425 pairs, 4,425 distinct gold cases.** No case appears twice, and
  no case is shared between two categories — each category is measured on its own
  disjoint sample.
- **295 pairs per category, exactly.** Equal allocation is deliberate: it makes the
  macro-average and the pooled rate the same number, so there is no weighting choice to
  defend and no way to move the headline by re-weighting.
- **Disjoint from every other split by assertion, not by hashing.** Every case name used
  by an internal split is removed by exact match and the build fails if the intersection
  is non-empty.
- **41 jurisdictions**, federal and state; cases filed between 1792 and 2025.

Equal weighting across 15 categories **is a chosen allocation, not an observed user
distribution.** The headline is therefore not a forecast of production accuracy.

The 15 categories are the ways a user or an agent actually produces a case name that
does not match the corpus's stored caption byte-for-byte: abbreviating, misspelling,
dropping or reordering a party, searching on a single name, or reformatting punctuation
and whitespace when the caption passes through another system. Each one is measured on
its own disjoint sample so that no category borrows another's difficulty, and each is
scored against its own unperturbed control so a category's score reflects the
perturbation, not how hard its cases happen to be.

### The 15 categories

Each category perturbs the caption a different way and is scored against its own
unperturbed control (see "The paired design" above).

| Category | What the query does to the caption |
|---|---|
| `abbreviation_contract` | One long form replaced by its accepted abbreviation — `Boards of Education` → `Boards of Educ.` |
| `amp_and_swap` | `&` written as `and`, or the reverse — `Rob's Cleaning & Powerwash` → `Rob's Cleaning and Powerwash` |
| `ampersand_elide` | The ampersand deleted outright — `Atchison & Northwestern` → `Atchison Northwestern` |
| `whitespace_mangle` | A double space or a tab in place of one space. Never removes every space. |
| `case_toggle` | Every word title-cased — `The State of Arizona v. Ahlersmeyer` → `The State Of Arizona V. Ahlersmeyer` |
| `separator_swap` | `v.` written as `vs.` or `versus` |
| `diacritic_inject` | A combining accent added to a party token — `Air-Line` → `Air-Líne` |
| `corporate_suffix_drop` | A trailing `Co.` / `Corp.` / `Inc.` / `LLC` omitted — `Tri-Pure Products Co.` → `Tri-Pure Products` |
| `initial_spacing` | The space between initials collapsed — `S. S. Alcoa Pennant` → `S.S. Alcoa Pennant` |
| `diacritic_strip` | Accents folded to ASCII — `Perché` → `Perche` |
| `country_form` | `United States` written as `U.S.`, `US` or `USA`, or the reverse |
| `party_order_swap` | The parties reversed — `Crease v. State` queried as `State v. Crease` |
| `party_misspell` | Two adjacent letters transposed inside a party token — `Ogden` → `Ogdne` |
| `party_truncate` | Only the first named party kept on each side — `Drennen & Co. v. Smith` → `Drennen v. Smith` |
| `single_party_search` | One party named and nothing else — `Corcoran v. State` queried as `Corcoran`. **Matched by whole-token containment, not equality** — see below. |

#### Matching rule: equality, except one category

Every category scores a hit by **normalized caption equality** against the gold
caption: the top result's caption, lowercased, whitespace-normalized, and diacritic-folded,
must equal the target normalized the same way — `Peña v. State` and `Pena v. State`
compare equal. Equality, not containment — containment would let a gold `Smith v. Jones`
match a returned `Smith v. Jones Manufacturing Co.`, which is a different company, so
equality is the safer default whenever the query is a full case name.

Diacritic folding is Unicode NFD decomposition with combining marks stripped, which
covers an accented Latin letter (`é` → `e`) but not a ligature: `Æ` and `œ` are single
code points with no combining-mark decomposition, so a caption using either is compared
unfolded.

`single_party_search` cannot use equality, because its query is not a full case name —
it is a deliberate party-name fragment. A bare `Corcoran` can never equal
`Corcoran v. State`. That category instead matches by **whole-token containment against
the query**: every normalized token of the query fragment must appear as its own whole
token in the candidate caption. Whole-token, not substring — `Brown` does not match
`Browning v. State`, because `brown` is not one of `browning`'s tokens. Whole-token
containment is the tightest match available once equality is off the table for a
fragment query.

### The negatives set

50 invented captions — parties that appear nowhere in the corpus in that pairing. The
correct answer for all 50 is an empty page. Absence was verified against the live index
at build time: a proposal that resolved to a real document was dropped as a mislabelled
positive rather than emitted.

The 50 rows are the complete cross product of ten invented surnames (`Brambury`,
`Bramcombe`, `Bramdahl`, `Bramfield`, `Bramgate`, `Bramholm`, `Bramridge`, `Bramstead`,
`Bramthwaite`, `Bramworth` — all sharing the stem `Bram-`) against five invented
entities, not fifty independently chosen names. No row carries a jurisdiction, so every
query falls through to the provider's federal default. The false-positive rate below is
therefore a measurement of one orthographic neighbourhood at one jurisdiction, not of
fifty independent probes — see "What this benchmark cannot claim."

This tier reports a **false-positive rate and never a hit rate**, and it is excluded
from the headline by construction.

## Published numbers

The `trustfoundry-legal-search` provider (`model_type: case_name`) results below are
the current canonical published numbers for this suite. Bundles are checksummed and
verifiable with `pnpm benchmark verify-result <bundle>`.

### Headline

| Metric | Value |
|---|---|
| hit@1 (macro-averaged across 15 categories) | 0.9331 |
| hit@1 (pooled) | 0.9331 — identical to the macro average under this suite's equal allocation |
| hit@1 95% CI | [0.9254, 0.9401] |
| hit@3 | 0.9544 |
| hit@5 | 0.9584 |
| hit@10 | 0.9584 |
| MRR | 0.9437 |
| `wrong_name` rate (headline population) | 0.0943 — share of returned *results*, pooled across the 4,423 of 4,425 rows the metric applies to; 2 rows excluded because every query token is on the stoplist |
| Rows | 8,850 (4,425 pairs — one perturbed row and one control row per case — across 15 categories × 295 pairs) |
| `providerFailures` | 0 |
| Latency | p50 406 ms, p95 511 ms, mean 429 ms — measured at 4 concurrent requests (`--parallel 4`), 8,850 requests, 1019 s elapsed, 8.68 rows/s |

### Per-category hit@1

Perturbed is the axis under test; control is the same 295 cases queried by their own
unperturbed caption; delta is perturbed − control. The 95% CI is Wilson, on the
perturbed arm, computed the same way as the published headline's `ci95`.

| Category | n | Perturbed hit@1 | Control hit@1 | Delta | 95% CI (perturbed) |
|---|---:|---:|---:|---:|---|
| `abbreviation_contract` | 295 | 0.9898 | 0.9932 | −0.0034 | [0.9705, 0.9965] |
| `amp_and_swap` | 295 | 0.9831 | 0.9831 | +0.0000 | [0.9609, 0.9927] |
| `ampersand_elide` | 295 | 0.9831 | 0.9797 | +0.0034 | [0.9609, 0.9927] |
| `case_toggle` | 295 | 0.9797 | 0.9797 | +0.0000 | [0.9563, 0.9906] |
| `corporate_suffix_drop` | 295 | 0.9695 | 0.9898 | −0.0203 | [0.9430, 0.9839] |
| `country_form` | 295 | 0.9254 | 0.9254 | +0.0000 | [0.8897, 0.9502] |
| `diacritic_inject` | 295 | 0.9729 | 0.9729 | +0.0000 | [0.9474, 0.9862] |
| `diacritic_strip` | 295 | 0.9458 | 0.9458 | +0.0000 | [0.9137, 0.9663] |
| `initial_spacing` | 295 | 0.9559 | 0.9763 | −0.0203 | [0.9261, 0.9741] |
| `party_misspell` | 295 | 0.8407 | 0.9831 | −0.1424 | [0.7946, 0.8780] |
| `party_order_swap` | 295 | 0.8949 | 0.9966 | −0.1017 | [0.8547, 0.9250] |
| `party_truncate` | 295 | 0.8034 | 0.9831 | −0.1797 | [0.7543, 0.8447] |
| `separator_swap` | 295 | 0.9763 | 0.9831 | −0.0068 | [0.9518, 0.9885] |
| `single_party_search` | 295 | 0.7932 | 0.9932 | −0.2000 | [0.7434, 0.8355] |
| `whitespace_mangle` | 295 | 0.9831 | 0.9831 | +0.0000 | [0.9609, 0.9927] |

**Six categories read delta exactly `0.0000` on this run: `amp_and_swap`, `case_toggle`,
`country_form`, `diacritic_inject`, `diacritic_strip`, `whitespace_mangle`.** This is not
rounding — for each of these six, every one of the 295 pairs carries an identical hit
rank between its perturbed and control row, while none of the 295 pairs share an
identical query string. That is a narrower claim than it might sound: it is not the
same for all six axes once you look past the rank to the rest of the page. For
`case_toggle`, `country_form`, `diacritic_inject`, and `whitespace_mangle`, the
perturbed and control rows return an identical result set, in the same order, on all
295 pairs. `diacritic_strip` matches on 294 of 295. `amp_and_swap` is different in
kind — its result set differs between the two arms on 110 of the 295 pairs, 23 of
those with a different number of results — yet the hit rank still coincides on every
one of the 295, because whichever result lands at the target rank is the same case
either way. `diacritic_strip` and `country_form` illustrate why the paired design
matters here — both read below 0.95 on *both* arms, meaning those 295 cases are simply
harder to retrieve regardless of any perturbation; the perturbation itself costs
nothing. `single_party_search` is the sharpest contrast: a bare party-name fragment
measurably changes the query, and it carries the largest delta of any category. It is
also the one category whose two arms are not scored by the same rule: the perturbed
arm matches by whole-token containment against the query fragment, while its control
arm — an ordinary full caption — matches by equality against gold, the same rule every
other category's control uses. The case sample is held fixed across the pair; the
matching rule is not, so this delta carries a second effect the other fourteen don't.

### Wrong-name rate by category

The share of returned results sharing no distinctive party token with the query, per
category and per arm (see ["Metrics"](#metrics) below for the stoplist and exclusion
rule).

| Category | Perturbed | Control |
|---|---:|---:|
| `abbreviation_contract` | 0.0267 | 0.0183 |
| `amp_and_swap` | 0.0181 | 0.0140 |
| `ampersand_elide` | 0.0150 | 0.0141 |
| `case_toggle` | 0.1485 | 0.1485 |
| `corporate_suffix_drop` | 0.0398 | 0.0354 |
| `country_form` | 0.0969 | 0.0944 |
| `diacritic_inject` | 0.1123 | 0.1123 |
| `diacritic_strip` | 0.1227 | 0.1220 |
| `initial_spacing` | 0.0492 | 0.0362 |
| `party_misspell` | 0.2465 | 0.1480 |
| `party_order_swap` | 0.1268 | 0.1391 |
| `party_truncate` | 0.0611 | 0.0169 |
| `separator_swap` | 0.1074 | 0.1036 |
| `single_party_search` | 0.1240 | 0.1010 |
| `whitespace_mangle` | 0.1055 | 0.1055 |

### Negatives

| n | False positives | Correct empty | `fp_rate` |
|---:|---:|---:|---:|
| 50 | 42 | 8 | 0.84 |

Every one of the 42 false positives is a real, existing case with a similarly spelled
party name — `Embury v. King`, `Bramley v. Dilworth`, `Brackenbury v. Astrue` — never a
fabricated or synthetic document, averaging 2.3 results per row across the negatives
set. That is what the cost ratio at the top of this document rests on: a wrong result
on the page is a real opinion a reader can open and rule out, not a confabulation, which
is why this suite treats it as the cheaper failure mode next to returning nothing.

Latency on the negatives set: p50 321 ms, p95 1038 ms, mean 598 ms — measured at 4
concurrent requests, 50 requests.

### Bundles

| Date | Target | Bundle |
|---|---|---|
| 2026-09-09 | public | [`8850`](../../results/trustfoundry-case-name-lookup/2026-09-09/public/8850/) |
| 2026-09-09 | negatives | [`50`](../../results/trustfoundry-case-name-lookup/2026-09-09/negatives/50/) |

**Latest pointer.** [`results/trustfoundry-case-name-lookup/latest.json`](../../results/trustfoundry-case-name-lookup/latest.json) maps each `(type, size)` to its currently-canonical dated bundle. `pnpm verify:results` verifies the pointer and every bundle it references.

For a concrete example of what a bundle's scored summary looks like, see [`results/trustfoundry-case-name-lookup/2026-09-09/public/8850/result.json`](../../results/trustfoundry-case-name-lookup/2026-09-09/public/8850/result.json). The full checked-in bundle also carries the raw row-level evidence, manifest, and checksums.

## Test data schema

Each line of a dataset JSONL is one JSON object.

| Field | Description |
|---|---|
| `query_text` | The case-name query sent to the search API, verbatim. For a `perturbed` row this is the mangled caption; for a `control` row it is `expected.case_name` sent unchanged. |
| `caseId` | Stable row identifier. Also the join key into a bundle's `raw.jsonl`. |
| `expected.case_name` | The caption as the corpus stores it. This is the gold value hit@K matches against for every category except `single_party_search`, which matches the query text itself (see "Matching rule" above). Identical for a perturbed row and its paired control. |
| `expected.arm` | `perturbed` or `control`. See "The paired design." |
| `expected.pair_id` | Joins a perturbed row to its control row — both carry the same value. |
| `expected.name_transform` | Which of the 15 categories this row belongs to. Shared by both arms of a pair. `null` on every row of the negatives set. |
| `expected.geo_level_1_identifier` / `geo_level_2_identifier` | Jurisdiction. The provider forwards this as the API's `state` filter; an empty `geo_level_2` means federal. |
| `expected.authority_identifier` | Court identifier, e.g. `ca5`, `conn`. |
| `expected.court_name` | `""` on every row of the public set; absent from the negatives set. The court is identified by `expected.authority_identifier` instead. |
| `expected.year_filed` | Year the case was filed. |
| `expected.kind` | `positive` on every row of the public set, `negative` on every row of the negatives set. |
| `expected.tier` | `qualified` on the public set, `negatives` on the negatives set. |
| `expected.synthetic` | `false` on every row of this release. |
| `expected.citation_form` | `reporter` on every row of the public set — descriptive of how the corpus stores the case's citation, not a field scoring reads. |
| `expected.corpus_cluster_size` / `expected.jurisdiction_cluster_size` | Cluster-size diagnostics; `null` on every row of this release. |
| `expected.demoted_from_ambiguous` | `false` on every row of this release. |
| `expected.datasource_id` | Provenance of the gold case. `courtlistener` throughout the published set. |
| `expected.negative_category` | `fabricated_name` on every row of the negatives set; absent from the public set. |

Gold identity is **the caption itself**, never a citation or an internal document id.
That is a deliberate constraint: the suite must be scoreable by anyone using only fields
the public API returns.

## Metrics

- **`hit@K`** — the top-`K` results contain a caption match for the target. Cutoffs are
  `[1, 3, 5, 10]`. Equality for every category except `single_party_search`, which
  matches by whole-token containment against the query fragment (see "Matching rule"
  above).
- **`hit@1` is the headline.** hit@3/@5/@10 are reported beside it from the same
  configured cutoff list so the drop-off past the top slot is visible.
- **`deduped_hit@K`** — the same measure over a page deduplicated on `(caption, year)`.
  Deduplication never changes whether a row counts as a hit, only how far a user had to
  read past repeated captions to reach a new case. **The key is `(caption, year)` and not
  caption alone**: a caption is not a document identity — the same caption can belong to
  cases decided in different years — and collapsing on caption alone would merge
  genuinely different cases.
- **`wrong_name`** — the share of returned results that share no distinctive party token
  with the query, after a stoplist drops high-frequency, non-identifying tokens: `v`,
  `vs`, `versus`, `in`, `re`, `ex`, `rel`, `the`, `of`, `and`, `state`, `states`,
  `united`, `commonwealth`, `people`, `city`, `county`, `inc`, `co`, `corp`, `llc`,
  `ltd`, `company`. Reported beside the hit rate, never folded into it.
  `applicable_n`/`excluded_n` count queries whose every token is on the stoplist,
  so the rate never silently reads as computed over a smaller population than it states.
  `summary.wrong_name` reports it over the headline population (positive, non-synthetic,
  perturbed); `by_axis[axis].perturbed.wrong_name` and `by_axis[axis].control.wrong_name`
  report the same rate per category and per arm, each carrying its own `applicable_n`/
  `excluded_n`.
- **`MRR`** — mean reciprocal rank over the recall rows.
- **`order_preference`** — a per-row diagnostic on `party_order_swap` only: if a `B v. A`
  query returns a real, distinct `A v. B` document elsewhere in the corpus, that document
  should not outrank the reversal the user actually typed. It never changes `score` or
  `hitRank`, and a row where no reversal appears in the corpus does not exercise the
  claim and cannot fail it.
- **Negative rows** score correct iff the provider returns zero results, aggregated
  separately as `negatives_overall.fp_rate` so a false-positive rate can never dilute a
  recall-shaped number.

**Where to read hit@1.** It is in `summary.overall.hit_at['hit@1']` of `scores.json`,
`report.json`, and a published bundle's `result.json` — as is every other configured
cutoff, keyed the same way (`hit_at['hit@3']`, not `hit_at['3']`). The macro-averaged,
per-category headline view lives at `summary.headline` (`macro`, `pooled`,
`per_category`, `ci95`). Per row, hit@K for any K is recoverable from `score.hit_rank`.

## Reproducing

```bash
export TF_API_KEY=...   # a TrustFoundry public API key

pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-case-name-lookup/v2-public.json \
  --provider-config  configs/providers/trustfoundry-case-name-lookup.json \
  --scorer-config    configs/scorers/trustfoundry-case-name-lookup.json \
  --out runs/v2-public --parallel 4 --retries 2

pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-case-name-lookup/v2-negatives.json \
  --provider-config  configs/providers/trustfoundry-case-name-lookup.json \
  --scorer-config    configs/scorers/trustfoundry-case-name-lookup.json \
  --out runs/v2-negatives --parallel 4 --retries 2
```

**Both arms are needed.** A recall number reported without the invariant population is
the half that flatters: any backend can raise its hit rate by answering more loosely,
and the negatives arm is what prices that. Read `summary.overall.hit_at['hit@1']` from
the public arm's `scores.json` together with `summary.negatives_overall.fp_rate` from
the negatives arm.

Two properties are worth asserting on your own runs, because both fail quietly:

- **`providerFailures` must be 0, and both arms must have the denominators above**
  (8,850 and 50). A run that lost rows to timeouts still reports a hit rate, and it will
  look better than it is — failures are excluded from the denominator, not counted as
  misses.
- **Every category must show exactly 295 perturbed rows and 295 control rows.** Equal
  allocation is what makes the macro-average and the pooled rate the same number. If
  they disagree, the run is incomplete and the headline is not weighting-independent.

## What this benchmark cannot claim

1. **That the category mix reflects user behaviour.** It does not, by construction. Equal
   allocation is what makes the headline un-gameable by re-weighting; it is not a model
   of how people type.
2. **That a small per-category difference is real.** At n=295 the 95% interval ranges
   from roughly ±1.3pp near the top of the range to roughly ±4.6pp for the categories
   nearer 0.80. Two categories within a few points of each other are not separated by
   this instrument — and because each category draws its own disjoint sample of cases,
   a per-category gap mixes the perturbation's effect with case-sampling variance, which
   is exactly what the paired control is there to separate out.
3. **That performance generalises outside these 15 categories.**
4. **That this forecasts production accuracy.** See (1).
5. **That the published set stays clean.** Once public, everyone iterates against it,
   including TrustFoundry, and it becomes a tuning set. That is the normal lifecycle of a
   published benchmark rather than a defect — which is why a private reserve split,
   never published, exists to confirm a new number generalises before it is quoted.
6. **That the corpus is fully covered.** Gold is drawn from CourtListener case law.
   Non-CourtListener documents in TrustFoundry's document store are deliberately
   unmeasured here.
7. **That the negatives arm samples fifty independent hallucination risks.** It is ten
   invented surnames sharing one stem (`Bram-`) crossed with five invented entities, all
   run at the federal jurisdiction. The 0.84 false-positive rate is a measurement of how
   one orthographic neighbourhood behaves at one jurisdiction, not an estimate over
   fifty independent name collisions.
