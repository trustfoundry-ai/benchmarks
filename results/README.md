# Results

## Path convention

```
results/<suite>/<yyyy-mm-dd>/<target>/
```

`<suite>` and `<target>` are the ids declared in `suites/<suite>/suite.json` — the
same pair the CLI takes as `--target <suite>/<target>` and the container takes as
`BENCHMARK_CONFIG`. One identifier names the config, the run, the bundle
directory, and the `latest.json` key.

`latest.json` maps each target id to its currently-canonical dated bundle.
`pnpm verify:results` verifies the pointer and every bundle it references.

The provider that produced the bundle is recorded inside the bundle's `manifest.json` (`manifest.provider.id`); it doesn't live in the path.

Each bundle contains raw rows, `result.json`, `manifest.json`, and `checksums.txt`. Raw rows are published gzipped as `raw.jsonl.gz`; the bundle manifest records the exact raw path and checksum.

Example:

```bash
pnpm benchmark publish-result \
  --run runs/trustfoundry-legal-search-case-questions-200 \
  --out results/trustfoundry-legal-search/2026-07-05/case-questions-200
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
