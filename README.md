# TrustFoundry Benchmarks

> **Status: Under active development (pre-1.0).**
> This harness is being iterated on in the open. Contracts,
> artifact schemas, and adapters may change between minor
> versions until v1.0. Individual benchmark suites carry
> their own maturity status — see the [suite status](#suite-status) table below.

This repository contains public benchmark harnesses for metrics TrustFoundry runs against its system. The goal is to make selected evaluations reproducible and extensible: you can rerun the same benchmark against TrustFoundry, inspect the row-level evidence behind the scores, or add another provider adapter for comparison.

## Suite status

| Suite | Status | Published numbers |
|---|---|---|
| `trustfoundry-legal-search` | Numbers published | 8 bundles under [`results/trustfoundry-legal-search/2026-07-05/`](results/trustfoundry-legal-search/2026-07-05/) (200-row and 5k-row × case-questions / key-facts / laws / regs) |
| `trustfoundry-citation-lookup` | In development | Not yet — dataset and scorer land in this release; evaluation numbers to follow. |

"Numbers published" means a scored result bundle exists under [`results/`](results/) with checksummed row-level evidence and passes `pnpm verify:results`. Suites marked "In development" ship the dataset, adapter, and scorer so consumers can rerun them locally — but the harness maintainers have not yet published a canonical evaluation.

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

## Suites

- [TrustFoundry Legal Search](suites/trustfoundry-legal-search/README.md): legal search recall over public 5,000-row case-question, key-fact, law, and regulation datasets.
- [Citation Lookup](suites/trustfoundry-citation-lookup/README.md): rank-1 citation-lookup accuracy over 4,618 rows of case-law, statute, regulation, and held-out non-citation negative queries, stratified by difficulty (clean vs. sloppy vs. reporter-variation).

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
- `suites/trustfoundry-legal-search/` and `suites/trustfoundry-citation-lookup/`: suite-specific documentation.
- `results/`: generated result bundles.
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

## Extending

The harness keeps benchmarks, providers, and scorers behind adapter boundaries. Future public suites can add a benchmark loader and scorer, while alternative platforms can add a provider adapter that returns the same normalized result shape used by the scorer.

Current adapters:

```bash
pnpm benchmark adapters
```

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
