# Results

Generated result bundles should use this folder convention:

```text
results/<suite-id>/<provider-id>/<yyyy-mm-dd>-<environment>-<run-label>/
```

Use lowercase kebab-case for each path segment. The `run-label` should capture the visible run shape, such as `default-200`, `default-5k`, or `comparison-200`. The generated `manifest.json` inside the bundle records the exact configs, data hashes, scheduler settings, and run ID.

Each bundle contains `raw.jsonl`, `result.json`, `manifest.json`, and `checksums.txt`.

Example:

```bash
pnpm benchmark publish-result \
  --run runs/public-search-200 \
  --out results/public-search-case-questions/trustfoundry-public-search/2026-06-26-production-default-200
```
