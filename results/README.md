# Results

Generated result bundles use this folder convention:

```text
results/<benchmark>/<yyyy-mm-dd>/<type>/<size>/
```

Segments (all lowercase kebab-case):

- `<benchmark>` — the suite family (e.g. `trustfoundry-legal-search`).
- `<yyyy-mm-dd>` — the date the run was executed against the live provider. All 200/5k × type combinations from one run day cluster under this dir.
- `<type>` — the benchmark target within the suite (e.g. `case-questions`, `key-facts`, `laws`, `regs`).
- `<size>` — the row count of the config that produced the bundle (`200` or `5k`).

The provider that produced the bundle is recorded inside the bundle's `manifest.json` (`manifest.provider.id`); it doesn't live in the path.

Each bundle contains raw rows, `result.json`, `manifest.json`, and `checksums.txt`. Large raw-row artifacts may be stored as `raw.jsonl.gz`; the bundle manifest records the exact raw path.

Example:

```bash
pnpm benchmark publish-result \
  --run runs/trustfoundry-legal-search-case-questions-200 \
  --out results/trustfoundry-legal-search/2026-07-05/case-questions/200
```

Published bundles are permanent. New runs land next to older ones; do not delete or overwrite a bundle.

## Suites whose gold does not fit the default raw-row shape

Each published row carries a fixed `expected` block built for single-citation gold —
`document_uuid`, `canonical_citation`, `alternates`. A suite whose gold has a different
shape declares `publishedExpectedFields` on its benchmark adapter, and those fields are
written into the published rows and restored when the bundle is re-scored.

`trustfoundry-case-name-lookup` is the first such suite: its gold is the caption itself, plus the
category, arm, and pair identifier its per-category table and paired-control comparison
are built from — not a citation at all. Without the declaration a re-score rebuilds
every row with no gold and no category and every metric silently reads 0 — so if you add
a suite in this shape, add a round-trip test with it.

The declaration is an allowlist, never a wildcard. `metadata.expected` can hold the
internal identifiers a row's build process relies on, and a published bundle is a public artifact.
