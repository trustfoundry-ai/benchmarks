# TrustFoundry Benchmarks

> **Status: Under active development (pre-1.0).**
> Current release: **0.8.0**. This harness is being iterated on in
> the open. Contracts, artifact schemas, and adapters may change
> between minor versions until v1.0. Individual benchmark suites
> carry their own maturity status — see the
> [suite status](#suite-status) table below.

This repository contains public benchmark harnesses for metrics TrustFoundry runs against its system. The goal is to make selected evaluations reproducible and extensible: you can rerun the same benchmark against TrustFoundry, inspect the row-level evidence behind the scores, or add another provider adapter for comparison.

## Why this exists

### Transparency and governance for published metrics

TrustFoundry publishes evaluation numbers about its own product. This harness is how we make those numbers reproducible under identical inputs — the run `manifest.json` pins the harness commit, config bytes, and dataset digests, and every published bundle carries per-file checksums for the row-level evidence. An auditor rerunning against a TrustFoundry API key can compare their bundle to ours row-for-row. Vendor stochasticity (LLM sampling, tool-use nondeterminism, model-snapshot floating) means two runs won't be byte-identical, but the manifest captures the axes so distributions remain directly comparable. See [Manifest And Reproducibility](#manifest-and-reproducibility) for the mechanism, [`docs/adapter-contracts.md`](docs/adapter-contracts.md#reproducibility-model) for what "reproducible" means at each layer, and [Verifying releases](#verifying-releases) for how to check that the harness code itself was built from this repo at the tagged commit.

### Why a legal-search benchmark, specifically

The public benchmarks in this space measure adjacent capabilities. [LegalBench](https://hazyresearch.stanford.edu/legalbench/) measures LLM legal-reasoning on small self-contained tasks with no external retrieval. [Harvey LAB](https://www.harvey.ai/blog/introducing-the-legal-agentic-benchmark-lab-a-benchmark-for-long-running-legal-work) measures long-running agentic workflows over customer documents without requiring actual legal authority as input. Neither measures a search engine's ability to *find, interpret, and surface specific legal authority* — a capability foundational to every legal-tech agent (research, drafting). This suite fills that gap across four document families: case opinions, case key facts, statutes, and regulations. The test data is question-answer style rather than keyword-based or citation-based, mirroring how lawyers and legal agents actually reach for authority — a materially harder and more valuable target than keyword matching or exact citation lookup. We have not seen it benchmarked publicly by anyone else.

### Why a citation-lookup benchmark, alongside

`citation-lookup` measures a different and lower-level capability: when a
user or downstream system already produces a citation string — Bluebook
canonical, state-legislature variant, or noisy transformation of either
— does the provider resolve it to the correct authority? Every
legal-tech agent that generates citations also has to *verify* them,
and every retrieval system that ranks over free-form questions still
needs a clean identity path when a citation is the query.

Existing public tooling narrows quickly. CourtListener's citation-lookup
endpoint and the open-source `eyecite` library both cover **opinion
citations only** — statute and regulation lookup falls outside their
scope, and neither systematically measures noisy-variant recovery. This
suite covers all four document families (federal cases, state cases,
statutes, regulations) with identity-based Recall@1 as the primary
metric.

Noise coverage is also broader than "user typos." Beyond dropped
punctuation, case toggling, section-marker swaps, character-level
typos, and spell-outs, the dataset exercises **state-legislature
variants** that diverge from Bluebook — the abbreviations state
codifiers actually publish, which users copy verbatim from official
state sites. Examples: `N.J.S.A.` vs `N.J. Stat. Ann.`, `RSMo` vs
`Mo. Rev. Stat.`, `KRS` vs `Ky. Rev. Stat. Ann.`, `NYCRR` vs `N.Y.
Comp. Codes R. & Regs.`. Statutes and regulations especially benefit
from this coverage; case reporters standardize on Bluebook naturally.

## Suite status

| Suite | Status | Published numbers |
|---|---|---|
| `trustfoundry-legal-search` | Numbers published | 8 bundles under [`results/trustfoundry-legal-search/2026-07-05/`](results/trustfoundry-legal-search/2026-07-05/) (200-row and 5k-row × case-questions / key-facts / laws / regs) |
| `citation-lookup` | Suite defined; publish to `results/` pending | Datasets + adapter + scorer + configs live in-tree; TrustFoundry TF-only summary + row-level scored bundles are checked in under [`trustfoundry-ai/benchmarks-lab`](https://github.com/Trust-Foundry/benchmarks-lab) at `experiments/citation-lookup/2026-07-10-trustfoundry-final/` (statutes+regs refreshed 2026-07-11 with a `variations` tier) |

"Numbers published" means a scored result bundle exists under [`results/`](results/) with checksummed row-level evidence and passes `pnpm verify:results`.

## Latest Benchmarks

These are the latest canonical benchmark runs in this repository. Dataset labels link to the raw and scored result bundles used to calculate each row; each checked-in bundle includes `manifest.json`, `checksums.txt`, scored results, and row-level raw evidence. Previous runs (if any) live alongside the latest under the same suite directory — browse `results/trustfoundry-legal-search/` and its date subdirectories to see the historical set.

<table>
  <thead>
    <tr>
      <th colspan="7" align="left">TrustFoundry Legal Search</th>
    </tr>
    <tr>
      <th>Date</th>
      <th>Dataset</th>
      <th>Recall@1</th>
      <th>Recall@25</th>
      <th>MRR</th>
      <th>Latency (p50)</th>
      <th>Latency (p95)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>2026-07-05</td>
      <td><a href="results/trustfoundry-legal-search/2026-07-05/case-questions/5k/">5000 case questions</a></td>
      <td>0.3868</td>
      <td>0.7114</td>
      <td>0.4723</td>
      <td>857 ms</td>
      <td>1248 ms</td>
    </tr>
    <tr>
      <td>2026-07-05</td>
      <td><a href="results/trustfoundry-legal-search/2026-07-05/key-facts/5k/">5000 key facts</a></td>
      <td>0.8734</td>
      <td>0.9766</td>
      <td>0.9128</td>
      <td>1051 ms</td>
      <td>1798 ms</td>
    </tr>
    <tr>
      <td>2026-07-05</td>
      <td><a href="results/trustfoundry-legal-search/2026-07-05/laws/5k/">5000 law questions</a></td>
      <td>0.6688</td>
      <td>0.9176</td>
      <td>0.7579</td>
      <td>729 ms</td>
      <td>1156 ms</td>
    </tr>
    <tr>
      <td>2026-07-05</td>
      <td><a href="results/trustfoundry-legal-search/2026-07-05/regs/5k/">5000 regulation questions</a></td>
      <td>0.5820</td>
      <td>0.9012</td>
      <td>0.6961</td>
      <td>788 ms</td>
      <td>1148 ms</td>
    </tr>
  </tbody>
</table>

<details>
<summary>TrustFoundry Legal Search details</summary>

Latest full 5k runs (2026-07-05; provider failures 0 for every row):

- Case questions: Recall@1 0.3868; Recall@10 0.639; Recall@25 0.7114; MRR 0.4723; latency p50 857 ms, p95 1248 ms. [5k results](results/trustfoundry-legal-search/2026-07-05/case-questions/5k/); [200-row companion](results/trustfoundry-legal-search/2026-07-05/case-questions/200/).
- Key facts: Recall@1 0.8734; Recall@10 0.9688; Recall@25 0.9766; MRR 0.9128; latency p50 1051 ms, p95 1798 ms. [5k results](results/trustfoundry-legal-search/2026-07-05/key-facts/5k/); [200-row companion](results/trustfoundry-legal-search/2026-07-05/key-facts/200/).
- Law questions: Recall@1 0.6688; Recall@10 0.8988; Recall@25 0.9176; MRR 0.7579; latency p50 729 ms, p95 1156 ms. [5k results](results/trustfoundry-legal-search/2026-07-05/laws/5k/); [200-row companion](results/trustfoundry-legal-search/2026-07-05/laws/200/).
- Regulation questions: Recall@1 0.5820; Recall@10 0.883; Recall@25 0.9012; MRR 0.6961; latency p50 788 ms, p95 1148 ms. [5k results](results/trustfoundry-legal-search/2026-07-05/regs/5k/); [200-row companion](results/trustfoundry-legal-search/2026-07-05/regs/200/).

</details>

For full runs with large raw artifacts, raw rows may be stored as `raw.jsonl.gz`; `pnpm benchmark verify-result <bundle>` reads the manifest path directly.

<details>
<summary>Citation Lookup — TrustFoundry results</summary>

Latest full runs against the four `citation-lookup` datasets. TrustFoundry's `citation_search` mode; 0 provider failures. Cases (federal + state) are 2026-07-10; statutes + regulations are 2026-07-11 (variations tier added). Bundles + row-level evidence live at [`trustfoundry-ai/benchmarks-lab`](https://github.com/Trust-Foundry/benchmarks-lab) under `experiments/citation-lookup/trustfoundry/` (per-slice `scores.json` + `provider-results.jsonl` + `manifest.json`).

Difficulty tiers: **Bluebook** = Bluebook canonical shape; **variations** = state-legislature abbreviations the state's own code site publishes (e.g. `N.J.S.A.`, `RSMo`, `OCGA`, `NYCRR`) — both regex-matched deterministically; **noisy** = sloppify-generated user-typed transformations (dropped punctuation, case toggling, character-level typos, spell-outs, section-marker swaps) — exercises the ML predict cascade.

| Dataset | Rows | Recall@1 (Bluebook) | Recall@1 (variations) | Recall@1 (noisy) | Combined MRR | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| cases-full | 688 BB + 2,032 noisy | 100.0% | — | 58.6% | 0.690 | 0.52s | 1.13s |
| cases-state-full | 200 BB + 600 noisy | 100.0% | — | 79.8% | 0.849 | 0.63s | 1.41s |
| statutes-full | 91 BB + 59 var + 273 noisy | 100.0% | 100.0% | 77.3% | 0.853 | 0.65s | 2.20s |
| regulations-full | 89 BB + 21 var + 267 noisy | 100.0% | 100.0% | 47.6% | 0.629 | 0.73s | 2.09s |
| negatives | 50 non-citations | 0 false positives (50/50 empty) | — | — | — | 0.28s | 0.41s |

Cases don't get a variations tier because case reporters are federal-standardized (F.2d, F.3d, S. Ct., etc.); the state-legislature variant concept only applies to statutes and regulations. Publishing scored bundles under `results/citation-lookup/` here is on the near-term roadmap; verification against the checked-in datasets works today via the standard `pnpm benchmark` workflow.

</details>

## Suites

- [TrustFoundry Legal Search](suites/trustfoundry-legal-search/README.md): legal search recall over public 5,000-row case-question, key-fact, law, and regulation datasets.
- [Citation Lookup](suites/citation-lookup/README.md): identity-based Recall@1 for citation strings — Bluebook canonical + sloppify-generated noisy variants — across federal cases, state cases, statutes, and regulations.

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

Run all four model types at full 5k and upload each verified bundle (cloud-agnostic destination — dispatched by URI scheme):

```bash
# Google Cloud Storage
docker run --rm \
  -e TF_API_KEY=$TF_API_KEY \
  -e BENCHMARK_CONFIG=all-5k \
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
- `BENCHMARK_CONFIG` — a config path under `configs/benchmarks/` without the `.json` extension (e.g. `trustfoundry-legal-search/key-facts-5k`), or one of the convenience aliases `all-200` / `all-5k` which expand to every matching config in sequence. Default: `trustfoundry-legal-search/case-questions-5k`.
- `RUN_LABEL` — short tag baked into the run ID. Default `manual`.
- `OUTPUT_BUNDLE_URI` — if unset, bundles stay on the container filesystem only. Supported schemes: `gs://` (via the bundled `gcloud` SDK), `file://` or an absolute path (local `cp`). To add another cloud, extend the `upload_bundle` dispatch in `entrypoint.sh`.

The image stamps the source commit it was built from into `$HARNESS_COMMIT_SHA`, and uploaded paths take the shape `${OUTPUT_BUNDLE_URI}/<benchmark-family>/<sha7>/<run-leaf>/`.

## Repository Layout

- `bin/` and `src/`: the benchmark CLI and harness framework.
- `configs/`: benchmark, provider, and scorer configuration.
- `data/`: public benchmark datasets.
- `suites/trustfoundry-legal-search/`, `suites/citation-lookup/`: suite-specific *documentation* only. Suite-scoped adapters live under `src/adapters/`.
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
