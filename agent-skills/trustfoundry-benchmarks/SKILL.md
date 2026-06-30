# TrustFoundry Benchmarks Skill

Use this skill when a user wants to run or inspect the public TrustFoundry benchmark harness in this repository.

## Workflow

1. Confirm the working directory is the repository root.
2. Ensure dependencies are installed with `pnpm install`.
3. Ensure `TF_API_KEY` is present in the environment for TrustFoundry public API runs.
4. For a quick check, run:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-legal-search-case-questions-200.json \
  --provider-config configs/providers/trustfoundry-public-search.json \
  --out runs/trustfoundry-legal-search-case-questions-200 \
  --parallel 8 \
  --force
```

5. For the full case-question suite, switch the benchmark config to `configs/benchmarks/trustfoundry-legal-search-case-questions-5k.json` and write to `runs/trustfoundry-legal-search-case-questions-5k`. For other targets, use the matching `key-facts`, `laws`, or `regs` config.
6. To package results:

```bash
pnpm benchmark publish-result \
  --run runs/trustfoundry-legal-search-case-questions-200 \
  --out results/trustfoundry-legal-search-case-questions/trustfoundry-public-search/2026-06-29-production-200-case-question \
  --force
pnpm benchmark verify-result results/trustfoundry-legal-search-case-questions/trustfoundry-public-search/2026-06-29-production-200-case-question
```

## Interpretation

Prioritize `strict_overall.hit_at.hit@25`, `overall.hit_at.hit@25`, `mrr`, provider failure rate, and p95 latency. `strict_overall` includes provider failures as misses; `overall` shows search quality on successfully scored rows.
