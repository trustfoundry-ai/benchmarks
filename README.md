# TrustFoundry Benchmarks

This repository contains public benchmark harnesses for metrics TrustFoundry runs against its system. The goal is to make selected evaluations reproducible and extensible: you can rerun the same benchmark against TrustFoundry, inspect the row-level evidence behind the scores, or add another provider adapter for comparison.

## Latest Benchmarks

These are the latest canonical benchmark runs in this repository. Each checked-in bundle includes `manifest.json`, `checksums.txt`, scored results, and row-level raw evidence.

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
      <td>2026-06-28</td>
      <td>5000 case questions</td>
      <td>0.3864</td>
      <td>0.7106</td>
      <td>0.4716</td>
      <td>927 ms</td>
      <td>1408.1 ms</td>
    </tr>
    <tr>
      <td colspan="7">Raw and scored results used to calculate these stats: <a href="results/public-search-case-questions/trustfoundry-public-search/2026-06-28-production-default-c8-5k/">5k result bundle</a></td>
    </tr>
  </tbody>
</table>

<details>
<summary>TrustFoundry Legal Search details</summary>

Latest full run: `2026-06-28-production-default-c8-5k`

- Dataset: 5000 case questions
- Rows: 5,000
- Concurrency: 8
- Provider failures: 0
- Recall@1: 0.3864
- Recall@10: 0.638
- Recall@25: 0.7106
- MRR: 0.4716
- Latency: p50 927 ms, p95 1408.1 ms
- Raw/scored results: [5k result bundle](results/public-search-case-questions/trustfoundry-public-search/2026-06-28-production-default-c8-5k/)
- Companion smoke run: [200-row c=8 result bundle](results/public-search-case-questions/trustfoundry-public-search/2026-06-28-production-default-c8-200/)

</details>

For full runs with large raw artifacts, raw rows may be stored as `raw.jsonl.gz`; `pnpm benchmark verify-result <bundle>` reads the manifest path directly.

## Suites

- [TrustFoundry Legal Search](suites/public-search/README.md): legal search recall over a public 5,000-row case-law question dataset.

## Setup

Install dependencies:

```bash
pnpm install
```

Set an API key from the [TrustFoundry dashboard](https://dashboard.trustfoundry.ai):

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
  -e BENCHMARK_SIZE=200 \
  -e MODEL_TYPES=case-questions \
  ttf-benchmarks
```

Run all four model types at full 5k and upload each verified bundle (cloud-agnostic destination — dispatched by URI scheme):

```bash
# Google Cloud Storage
docker run --rm \
  -e TF_API_KEY=$TF_API_KEY \
  -e OUTPUT_BUNDLE_URI=gs://your-bucket/your-prefix \
  -v $HOME/.config/gcloud:/root/.config/gcloud \
  ttf-benchmarks

# Local filesystem (bind-mount the destination)
docker run --rm \
  -e TF_API_KEY=$TF_API_KEY \
  -e OUTPUT_BUNDLE_URI=file:///out \
  -v $PWD/out:/out \
  ttf-benchmarks
```

The entrypoint reads `MODEL_TYPES` (comma-separated subset of `case-questions,key-facts,laws,regs` — default all four), `BENCHMARK_SIZE` (`200` or `5k` — default `5k`), `RUN_LABEL` (short tag baked into the run ID — default `manual`), and `OUTPUT_BUNDLE_URI` (if unset, bundles stay on the container filesystem only). Supported `OUTPUT_BUNDLE_URI` schemes: `gs://` (via the bundled `gcloud` SDK), `file://` or an absolute path (local `cp`). To add another cloud, extend the `upload_bundle` dispatch in `entrypoint.sh`.

The image stamps the source commit it was built from into `$HARNESS_COMMIT_SHA`, and uploaded paths take the shape `${OUTPUT_BUNDLE_URI}/<benchmark-family>/<sha7>/<run-leaf>/`.

## Repository Layout

- `bin/` and `src/`: the benchmark CLI and harness framework.
- `configs/`: benchmark, provider, and scorer configuration.
- `data/`: public benchmark datasets.
- `suites/public-search/`: suite-specific documentation.
- `results/`: generated result bundles.
- `agent-skills/`: optional agent workflow instructions.
- `Dockerfile`, `entrypoint.sh`: reproducible container image (see "Running the harness in a container" above).

## Extending

The harness keeps benchmarks, providers, and scorers behind adapter boundaries. Future public suites can add a benchmark loader and scorer, while alternative platforms can add a provider adapter that returns the same normalized result shape used by the scorer.

Current adapters:

```bash
pnpm benchmark adapters
```

## Development

Run tests:

```bash
pnpm test
```

Verify checked-in result bundles against raw results:

```bash
pnpm verify:results
```
