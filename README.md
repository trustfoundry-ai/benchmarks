# TrustFoundry Benchmarks

This repository contains public benchmark harnesses for metrics TrustFoundry runs against its system. The goal is to make selected evaluations reproducible and extensible: you can rerun the same benchmark against TrustFoundry, inspect the row-level evidence behind the scores, or add another provider adapter for comparison.

## Latest Benchmarks

These are the latest canonical benchmark runs in this repository. Dataset labels link to the raw and scored result bundles used to calculate each row; each checked-in bundle includes `manifest.json`, `checksums.txt`, scored results, and row-level raw evidence.

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
      <td>2026-06-29</td>
      <td><a href="results/trustfoundry-legal-search-case-questions/trustfoundry-public-search/2026-06-29-production-5k-case-question/">5000 case questions</a></td>
      <td>0.3864</td>
      <td>0.7106</td>
      <td>0.4716</td>
      <td>1050 ms</td>
      <td>1665 ms</td>
    </tr>
    <tr>
      <td>2026-06-29</td>
      <td><a href="results/trustfoundry-legal-search-key-facts/trustfoundry-public-search/2026-06-29-production-5k-case-key-fact/">5000 key facts</a></td>
      <td>0.8726</td>
      <td>0.9762</td>
      <td>0.9124</td>
      <td>2064.5 ms</td>
      <td>3313.1 ms</td>
    </tr>
    <tr>
      <td>2026-06-29</td>
      <td><a href="results/trustfoundry-legal-search-laws/trustfoundry-public-search/2026-06-29-production-5k-law-question/">5000 law questions</a></td>
      <td>0.6666</td>
      <td>0.9000</td>
      <td>0.7483</td>
      <td>889 ms</td>
      <td>1436 ms</td>
    </tr>
    <tr>
      <td>2026-06-29</td>
      <td><a href="results/trustfoundry-legal-search-regs/trustfoundry-public-search/2026-06-29-production-5k-reg-question/">5000 regulation questions</a></td>
      <td>0.5704</td>
      <td>0.8944</td>
      <td>0.6851</td>
      <td>942 ms</td>
      <td>1553 ms</td>
    </tr>
  </tbody>
</table>

<details>
<summary>TrustFoundry Legal Search details</summary>

Latest full runs:

- Case questions: `2026-06-29-production-5k-case-question`; 5,000 rows; c=8; provider failures 0; Recall@1 0.3864; Recall@10 0.638; Recall@25 0.7106; MRR 0.4716; latency p50 1050 ms, p95 1665 ms; [5k results](results/trustfoundry-legal-search-case-questions/trustfoundry-public-search/2026-06-29-production-5k-case-question/); [200-row companion](results/trustfoundry-legal-search-case-questions/trustfoundry-public-search/2026-06-29-production-200-case-question/).
- Key facts: `2026-06-29-production-5k-case-key-fact`; 5,000 rows; c=8; provider failures 0; Recall@1 0.8726; Recall@10 0.9688; Recall@25 0.9762; MRR 0.9124; latency p50 2064.5 ms, p95 3313.1 ms; [5k results](results/trustfoundry-legal-search-key-facts/trustfoundry-public-search/2026-06-29-production-5k-case-key-fact/); [200-row companion](results/trustfoundry-legal-search-key-facts/trustfoundry-public-search/2026-06-29-production-200-case-key-fact/).
- Law questions: `2026-06-29-production-5k-law-question`; 5,000 rows; c=8; provider failures 0; Recall@1 0.6666; Recall@10 0.8816; Recall@25 0.9000; MRR 0.7483; latency p50 889 ms, p95 1436 ms; [5k results](results/trustfoundry-legal-search-laws/trustfoundry-public-search/2026-06-29-production-5k-law-question/); [200-row companion](results/trustfoundry-legal-search-laws/trustfoundry-public-search/2026-06-29-production-200-law-question/).
- Regulation questions: `2026-06-29-production-5k-reg-question`; 5,000 rows; c=8; provider failures 0; Recall@1 0.5704; Recall@10 0.8744; Recall@25 0.8944; MRR 0.6851; latency p50 942 ms, p95 1553 ms; [5k results](results/trustfoundry-legal-search-regs/trustfoundry-public-search/2026-06-29-production-5k-reg-question/); [200-row companion](results/trustfoundry-legal-search-regs/trustfoundry-public-search/2026-06-29-production-200-reg-question/).

</details>

For full runs with large raw artifacts, raw rows may be stored as `raw.jsonl.gz`; `pnpm benchmark verify-result <bundle>` reads the manifest path directly.

## Suites

- [TrustFoundry Legal Search](suites/public-search/README.md): legal search recall over public 5,000-row case-question, key-fact, law, and regulation datasets.

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
