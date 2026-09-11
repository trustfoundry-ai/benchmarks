# TrustFoundry Benchmarks

> **Status: Under active development (pre-1.0).**
> Latest release: **0.11.0** — see the [CHANGELOG](CHANGELOG.md) for what
> has landed since. This harness is being iterated on in the open.
> Contracts, artifact schemas, and adapters may change between minor
> versions until v1.0. Individual benchmark suites carry their own
> maturity status — see the [suite status](#suite-status) table below.

This repository contains public benchmark harnesses for metrics TrustFoundry runs against its system. The goal is to make selected evaluations reproducible and extensible: you can rerun the same benchmark against TrustFoundry, inspect the row-level evidence behind the scores, or add another provider adapter for comparison.

## Why this exists

### Transparency and governance for published metrics

TrustFoundry publishes evaluation numbers about its own product. This harness is how we make those numbers reproducible under identical inputs — the run `manifest.json` pins the harness commit, config bytes, and dataset digests, and every published bundle carries per-file checksums for the row-level evidence. An auditor rerunning against a TrustFoundry API key can compare their bundle to ours row-for-row. Vendor stochasticity (LLM sampling, tool-use nondeterminism, model-snapshot floating) means two runs won't be byte-identical, but the manifest captures the axes so distributions remain directly comparable. See [Manifest And Reproducibility](#manifest-and-reproducibility) for the mechanism, [`docs/adapter-contracts.md`](docs/adapter-contracts.md#reproducibility-model) for what "reproducible" means at each layer, and [Verifying releases](#verifying-releases) for how to check that the harness code itself was built from this repo at the tagged commit.

### Why a legal-search benchmark, specifically

The public benchmarks in this space measure adjacent capabilities. [LegalBench](https://hazyresearch.stanford.edu/legalbench/) measures LLM legal-reasoning on small self-contained tasks with no external retrieval. [Harvey LAB](https://www.harvey.ai/blog/introducing-the-legal-agentic-benchmark-lab-a-benchmark-for-long-running-legal-work) measures long-running agentic workflows over customer documents without requiring actual legal authority as input. Neither measures a search engine's ability to *find, interpret, and surface specific legal authority* — a capability foundational to every legal-tech agent (research, drafting). This suite fills that gap across four document families: case opinions, case key facts, statutes, and regulations. The test data is question-answer style rather than keyword-based or citation-based, mirroring how lawyers and legal agents actually reach for authority — a materially harder and more valuable target than keyword matching or exact citation lookup. We have not seen it benchmarked publicly by anyone else.

## Suite status

<!-- BEGIN GENERATED: suite-status -->
| Suite | Status | Targets | Published bundles |
|---|---|---:|---|
| [`trustfoundry-case-name-lookup`](suites/trustfoundry-case-name-lookup/README.md) | published | 3 | 3 bundles under [`results/trustfoundry-case-name-lookup/2026-09-10/`](results/trustfoundry-case-name-lookup/2026-09-10/) |
| [`trustfoundry-legal-search`](suites/trustfoundry-legal-search/README.md) | published | 8 | 8 bundles under [`results/trustfoundry-legal-search/2026-09-11/`](results/trustfoundry-legal-search/2026-09-11/) |
<!-- END GENERATED: suite-status -->

Only suites with `status: published` in their manifest (`suites/<id>/suite.json`) are listed above; `experimental` and `deprecated` suites are left out until they're ready. "Targets" is the number of benchmark × provider × scorer combinations the suite declares; "Published bundles" is how many of them currently have a checked-in, checksummed result bundle under [`results/`](results/) that passes `pnpm verify:results`.

## Latest Benchmarks

These are the latest canonical benchmark runs in this repository, one table per published suite, one row per headline target. Target labels link to the raw and scored result bundle each row's score is computed from; each checked-in bundle includes `manifest.json`, `checksums.txt`, scored results, and row-level raw evidence. A suite may report more than one headline number — legal-search reports one per document family — so a suite's table may carry several rows. Hit-rate columns are whichever cutoffs the suite's own scorer reports (`summary.overall.hit_at`); `provider failures` is failures out of total rows attempted, so a reader can tell a run was complete rather than missing rows. Non-headline targets — invariant/negative populations (reported as a false-positive rate, not a hit rate, since there's no gold document for a fabricated query to hit) and smoke-tier companions (a cheap subset of the same target) — are listed under each suite's table rather than given a row in it; browse `results/trustfoundry-legal-search/` or `results/trustfoundry-case-name-lookup/` and their date subdirectories for the full set either way.

<!-- BEGIN GENERATED: latest-benchmarks -->
#### TrustFoundry Case-Name Lookup

| Target | Rows | hit@1 | hit@3 | hit@5 | hit@10 | hit@1 95% CI | MRR | wrong-name rate | provider failures | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| [`public-8850`](results/trustfoundry-case-name-lookup/2026-09-10/public-8850/) | 8850 | 0.9331 | 0.9544 | 0.9584 | 0.9584 | [0.9254, 0.9401] | 0.9437 | 0.0943 | 0/8850 | 349 ms | 483 ms |

Latency measured at `--parallel 4`.

- **Invariant population** [`negatives-50`](results/trustfoundry-case-name-lookup/2026-09-10/negatives-50/): false-positive rate 0.8400 (lower is better) — 8/50 correctly returned no match.
- Smoke-tier companions (cheap, non-headline): [`public-1050`](results/trustfoundry-case-name-lookup/2026-09-10/public-1050/).

See [`suites/trustfoundry-case-name-lookup/README.md`](suites/trustfoundry-case-name-lookup/README.md) for the per-category and per-axis breakdown.

#### TrustFoundry Legal Search

| Target | Rows | hit@1 | hit@5 | hit@10 | hit@25 | hit@25 95% CI | MRR | wrong-name rate | provider failures | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| [`case-questions-5k`](results/trustfoundry-legal-search/2026-09-11/case-questions-5k/) | 5000 | 0.3938 | 0.5830 | 0.6454 | 0.7134 | [0.7007, 0.7258] | 0.4789 | — | 0/5000 | 862 ms | 1248 ms |
| [`key-facts-5k`](results/trustfoundry-legal-search/2026-09-11/key-facts-5k/) | 5000 | 0.8710 | 0.9600 | 0.9680 | 0.9760 | [0.9714, 0.9799] | 0.9112 | — | 0/5000 | 1079 ms | 1799 ms |
| [`laws-5k`](results/trustfoundry-legal-search/2026-09-11/laws-5k/) | 5000 | 0.6682 | 0.8660 | 0.8958 | 0.9144 | [0.9063, 0.9218] | 0.7560 | — | 0/5000 | 803 ms | 1210 ms |
| [`regs-5k`](results/trustfoundry-legal-search/2026-09-11/regs-5k/) | 5000 | 0.5764 | 0.8460 | 0.8794 | 0.8966 | [0.8879, 0.9047] | 0.6913 | — | 0/5000 | 816 ms | 1213 ms |

Latency measured at `--parallel 4`.

- Smoke-tier companions (cheap, non-headline): [`case-questions-200`](results/trustfoundry-legal-search/2026-09-11/case-questions-200/), [`key-facts-200`](results/trustfoundry-legal-search/2026-09-11/key-facts-200/), [`laws-200`](results/trustfoundry-legal-search/2026-09-11/laws-200/), [`regs-200`](results/trustfoundry-legal-search/2026-09-11/regs-200/).

See [`suites/trustfoundry-legal-search/README.md`](suites/trustfoundry-legal-search/README.md) for the per-category and per-axis breakdown.
<!-- END GENERATED: latest-benchmarks -->

Raw rows are published gzipped as `raw.jsonl.gz`; the manifest records the path and checksum, and `pnpm benchmark verify-result <bundle>` reads the manifest path directly.

## Suites

- [TrustFoundry Legal Search](suites/trustfoundry-legal-search/README.md): legal search recall over public 5,000-row case-question, key-fact, law, and regulation datasets.
- [TrustFoundry Case-Name Lookup](suites/trustfoundry-case-name-lookup/README.md): can a backend find a case when the user knows its name but not its citation? 8,850 rows across 15 categories of name variation — misspellings, abbreviations, reversed parties, a single party — each equally weighted and each paired against its own unperturbed control.

## Setup

Install dependencies:

```bash
pnpm install
```

Set an API key from your TrustFoundry account dashboard:

```bash
cp .env.example .env
export TF_API_KEY=your_key_here
```

See each suite README for run commands and suite-specific setup.

## Running the harness in a container

A `Dockerfile` and `entrypoint.sh` at the repository root package the harness for reproducible runs in any container runtime. The image contains Node 20, pnpm, the harness source, and the public datasets — no additional setup needed beyond providing a `TF_API_KEY`.

Build the image:

```bash
docker build -t ttf-benchmarks .
```

Run a 200-row case-questions smoke locally (results stay inside the container; copy them out with `docker cp` if needed):

```bash
docker run --rm \
  -e TF_API_KEY=$TF_API_KEY \
  -e BENCHMARK_CONFIG=trustfoundry-legal-search/case-questions-200 \
  ttf-benchmarks
```

Run every target in a suite at once and upload each verified bundle (cloud-agnostic destination — dispatched by URI scheme):

```bash
# Google Cloud Storage
docker run --rm \
  -e TF_API_KEY=$TF_API_KEY \
  -e BENCHMARK_CONFIG=trustfoundry-legal-search/all \
  -e OUTPUT_BUNDLE_URI=gs://your-bucket/your-prefix \
  -v $HOME/.config/gcloud:/root/.config/gcloud \
  ttf-benchmarks

# Local filesystem (bind-mount the destination)
docker run --rm \
  -e TF_API_KEY=$TF_API_KEY \
  -e BENCHMARK_CONFIG=trustfoundry-legal-search/laws-5k \
  -e OUTPUT_BUNDLE_URI=file:///out \
  -v $PWD/out:/out \
  ttf-benchmarks
```

The entrypoint reads:
- `BENCHMARK_CONFIG` — a target reference `<suite>/<target>`, or `all` to run every
  target in sequence, or `<suite>/all` for one suite's targets. Run
  `pnpm benchmark targets` for the full list. Default:
  `trustfoundry-legal-search/case-questions-5k`.
- `RUN_LABEL` — short tag baked into the run ID. Default `manual`.
- `OUTPUT_BUNDLE_URI` — if unset, bundles stay on the container filesystem only. Supported schemes: `gs://` (via the bundled `gcloud` SDK), `file://` or an absolute path (local `cp`). To add another cloud, extend the `upload_bundle` dispatch in `entrypoint.sh`.
- `DRY_RUN` — resolve and print every target that would run, then exit without running anything.

Every target's benchmark, provider, and scorer config paths are resolved through the suite registry (`suites/<suite>/suite.json`), so adding a suite or a target needs no change to the entrypoint itself.

The image stamps the source commit it was built from into `$HARNESS_COMMIT_SHA`, and uploaded paths take the shape `${OUTPUT_BUNDLE_URI}/<suite>/<sha7>/<date>-<run-label>-<target>/`.

## Repository Layout

- `bin/` and `src/`: the benchmark CLI and harness framework.
- `configs/`: benchmark, provider, and scorer configuration.
- `data/`: public benchmark datasets.
- `suites/trustfoundry-legal-search/`: suite-specific *documentation* only. Suite-scoped adapters live under `src/adapters/`.
- `results/`: published result bundles, organized as `results/<benchmark>/<date>/<type>/<size>/`. Each benchmark also has a `results/<benchmark>/latest.json` pointer that names the currently-published bundle for each `(type, size)` — stable URL for external consumers who don't want to guess the date.
- `agent-skills/`: optional agent workflow instructions.
- `Dockerfile`, `entrypoint.sh`: reproducible container image (see "Running the harness in a container" above).

## Manifest And Reproducibility

Every run writes a `manifest.json` that pins the exact harness version and
inputs used. Consumers can rerun the same benchmark against the same
harness build by cloning the repo at the recorded commit:

```json
{
  "harness": {
    "name": "@trustfoundry-ai/benchmarks-harness",
    "originUrl": "https://github.com/trustfoundry-ai/benchmarks.git",
    "commit": "<git sha>",
    "version": "<package version>"
  },
  "benchmark": { "id": ..., "configSha256": ..., "sourceFiles": [ ... ] },
  "provider":  { "id": ..., "configSha256": ..., "subject": ..., "model": ... },
  "scorer":    { "id": ..., "configSha256": ..., "extractionVersion": ... },
  "fingerprints": { "compatibility": ..., "resume": ..., "manifest": ... }
}
```

`harness.commit` and `harness.version` are populated automatically from
this repo's git HEAD and `package.json`; overrides (`GITHUB_SHA`,
`EVAL_HARNESS_SHA`, `EVAL_HARNESS_VERSION`) are honored for CI images
that carry the source out of a git tree.

The three fingerprints let downstream tooling reason about run identity:
matching `compatibility` fingerprints can be merged and compared;
matching `resume` fingerprints share the same shard slice; the
`manifest` fingerprint is unique per run.

See [Reproducing a published number](docs/reproducing.md) for the step-by-step recipe.

### Verifying releases

Each tagged release ships with a signed [SLSA build provenance
attestation](https://slsa.dev/spec/v1.0/provenance) produced by GitHub's
[`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)
action. Verify the release tarball before consuming it:

```bash
gh release download v0.8.0 -R trustfoundry-ai/benchmarks \
    -p 'trustfoundry-ai-benchmarks-harness-*.tgz'

gh attestation verify \
    trustfoundry-ai-benchmarks-harness-0.8.0.tgz \
    -R trustfoundry-ai/benchmarks
```

`gh attestation verify` confirms the tarball was built by this repo's
release workflow at the tagged commit; a mismatched or missing
attestation fails the check.

## Extending

The harness keeps benchmarks, providers, and scorers behind adapter boundaries. Future public suites can add a benchmark loader and scorer, while alternative platforms can add a provider adapter that returns the same normalized result shape used by the scorer.

Current adapters:

```bash
pnpm benchmark adapters
```

### Adding a suite

A suite is a benchmark, a scorer, one or more datasets, and a manifest
naming the targets they combine into. See
[`docs/adding-a-suite.md`](docs/adding-a-suite.md) for the full walkthrough —
naming, writing the adapters, declaring targets in `suites/<suite>/suite.json`,
and publishing a bundle.

### Coding-agent skill

If you're using a coding agent to add a new provider adapter, this repository ships a skill that walks a fresh session through the whole checklist — adapter module, provider + benchmark configs, tests, docs, and a one-row smoke against the vendor API — modeled on the five shipped `-legal-search` adapters. The same skill is checked in twice, once per agent convention:

- **Claude Code** — [`.claude/skills/legal-search-adapter/SKILL.md`](.claude/skills/legal-search-adapter/SKILL.md)
- **OpenAI Codex** — [`.agents/skills/legal-search-adapter/SKILL.md`](.agents/skills/legal-search-adapter/SKILL.md)

The two files are content-identical; each agent picks up its native convention automatically. The skill fires when a session asks to add a case-law retrieval provider (LLM API with web search, search engine, vector DB, legal-tech vendor).

## Public API

`@trustfoundry-ai/benchmarks-harness` exposes a curated set of named exports from its root barrel. Anything imported from that surface follows semver — additive changes are minor bumps, breaking changes are major bumps.

The public surface groups by purpose:

- **Adapter authoring** — `defineBenchmarkAdapter`, `defineProviderAdapter`, `defineScorerAdapter`, `defaultRegistry`, `createRegistry`, `getAdapter` (+ per-kind getters), `adapterInventory`.
- **Run entry points** — `executeRun` (+ `runOpenEvaluation` alias), `scoreRun`, `retryFailedRun` (+ `retryFailed` alias), `mergeRuns`, `buildReport`, `executeProviderCaseWithRetry`.
- **Adapter id + scorer config validation** — `benchmarkAdapterId`, `providerAdapterId`, `scorerAdapterId`, `maxScorerCutoff`, `readApiRequestLimit`, `validateApiRequestLimitAgainstCutoffs`, `validateScorerCutoffsMatchImplementation`.
- **Reference implementations for adapters** — `FileBackedRateLimiter`, `createProviderRateLimiter`, `rateLimitedProviderResult`, `summarizeTokenUsage`, `normalizeTokenUsage`, `writeCaseCheckpoint`, `loadCaseCheckpoints`, `writeCaseProgressCheckpoint`, `clearCheckpoints`, `buildManifest`, `assertCompatibleManifest`, `computeFingerprints`.
- **Result artifacts + verification** — `publishResultBundle`, `verifyResultBundle`, `buildRawRow` / `buildRawRows`, `reconstructPairFromRawRow` / `reconstructFromRawRows`, `scoreRawRows`, `readRawJsonl`.
- **Primitives for adapter authors** — `readJson` / `writeJson` / `readJsonl` / `readJsonlStream` / `writeJsonl` / `writeText` / `exists` / `relativePath` / `createJsonlWriter`, `sha256Text` / `sha256File`, `stableJson` / `hashObject` / `hashFile`, `canonicalStringify`, `acceptedCitationSet` / `normalizeCitation` / `splitCitationList`, `applyQueryTransform` / `stripSyntheticInstructionPrefixes`, `mapWithConcurrency` / `applyShard` / `normalizeScheduler`.

See [`docs/adapter-contracts.md`](docs/adapter-contracts.md) for the long-form contract guide and [`src/core/contracts/README.md`](src/core/contracts/README.md) for the adapter-authoring reference.

**Not public API:** everything in `src/core/*.mjs` that is NOT re-exported by [`src/index.mjs`](src/index.mjs) — those helpers are internal and may change without notice. If you need to reach into them, pin a specific version of the package first.

## Development

Run tests:

```bash
pnpm test
```

Verify checked-in result bundles against raw results:

```bash
pnpm verify:results
```
