# Results

Generated result bundles use this folder convention:

```text
results/<suite-id>/<yyyy-mm-dd>/<run-leaf>/
```

Use lowercase kebab-case for each path segment. The `run-leaf` should capture the visible run shape, e.g. `production-200-case-question`, `production-5k-case-key-fact`, or `comparison-200`. The provider that produced the bundle is recorded inside the bundle's `manifest.json` (`manifest.provider.id`); it doesn't live in the path.

Each bundle contains raw rows, `result.json`, `manifest.json`, and `checksums.txt`. Large raw-row artifacts may be stored as `raw.jsonl.gz`; the bundle manifest records the exact raw path.

Example:

```bash
pnpm benchmark publish-result \
  --run runs/trustfoundry-legal-search-case-questions-200 \
  --out results/trustfoundry-legal-search-case-questions/2026-07-05/production-200-case-question
```

Published bundles are permanent. New runs land next to older ones; do not delete or overwrite a bundle.
