# TrustFoundry Benchmarks Skill

Use this skill when a user wants to run or inspect the public TrustFoundry benchmark harness in this repository.

## Workflow

1. Confirm the working directory is the repository root.
2. Ensure dependencies are installed with `pnpm install`.
3. Ensure `TF_API_KEY` is present in the environment for TrustFoundry public API runs.
4. For a quick check, run:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/public-search-case-questions-200.json \
  --provider-config configs/providers/trustfoundry-public-search-case-question.json \
  --out runs/public-search-200 \
  --parallel 4 \
  --force
```

5. For the full suite, switch the benchmark config to `configs/benchmarks/public-search-case-questions-5k.json` and write to `runs/public-search-5k`.
6. To package results:

```bash
pnpm benchmark publish-result --run runs/public-search-200 --out results/public-search-200 --force
pnpm benchmark verify-result results/public-search-200
```

## Interpretation

Prioritize `strict_overall.hit_at.hit@25`, `overall.hit_at.hit@25`, `mrr`, provider failure rate, and p95 latency. `strict_overall` includes provider failures as misses; `overall` shows search quality on successfully scored rows.
