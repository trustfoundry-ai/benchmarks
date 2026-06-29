# TrustFoundry Benchmarks

This repository contains public benchmark harnesses for metrics TrustFoundry runs against its system. The goal is to make selected evaluations reproducible and extensible: you can rerun the same benchmark against TrustFoundry, inspect the row-level evidence behind the scores, or add another provider adapter for comparison.

## Latest Benchmarks

These are the latest published benchmark runs in this repository. The raw results used to calculate each row of stats are linked in the `Raw Results` column; each checked-in bundle includes `manifest.json`, `checksums.txt`, scored results, and row-level raw evidence.

| Suite | Run | Rows | Concurrency | Provider Failures | Hit@1 | Hit@10 | Hit@25 | MRR | p50 Latency | p95 Latency | Raw Results |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Public Search Case-Question Recall | `2026-06-28-production-default-c8-5k` | 5,000 | 8 | 0 | 0.3864 | 0.638 | 0.7106 | 0.4716 | 927 ms | 1408.1 ms | [`results/.../2026-06-28-production-default-c8-5k`](results/public-search-case-questions/trustfoundry-public-search/2026-06-28-production-default-c8-5k/) |
| Public Search Case-Question Recall | `2026-06-28-production-default-c8-200` | 200 | 8 | 0 | 0.385 | 0.635 | 0.715 | 0.4712 | 907.5 ms | 1683.15 ms | [`results/.../2026-06-28-production-default-c8-200`](results/public-search-case-questions/trustfoundry-public-search/2026-06-28-production-default-c8-200/) |

For full runs with large raw artifacts, raw rows may be stored as `raw.jsonl.gz`; `pnpm benchmark verify-result <bundle>` reads the manifest path directly.

## Suites

- [Public Search Case-Question Recall](suites/public-search/README.md): search recall over a public 5,000-row case-law question dataset.

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

## Repository Layout

- `bin/` and `src/`: the benchmark CLI and harness framework.
- `configs/`: benchmark, provider, and scorer configuration.
- `data/`: public benchmark datasets.
- `suites/public-search/`: suite-specific documentation.
- `results/`: generated result bundles.
- `agent-skills/`: optional agent workflow instructions.

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
