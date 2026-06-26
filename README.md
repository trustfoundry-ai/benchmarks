# TrustFoundry Benchmarks

This repository contains public benchmark harnesses for metrics TrustFoundry runs against its system. The goal is to make selected evaluations reproducible and extensible: you can rerun the same benchmark against TrustFoundry, inspect the row-level evidence behind the scores, or add another provider adapter for comparison.

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
