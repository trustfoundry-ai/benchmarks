# Contributing

Thanks for helping improve TrustFoundry Benchmarks. This repository is intended to keep public benchmark definitions, data, and published result artifacts reproducible.

## Development

Install dependencies and run the local checks before opening a pull request:

```bash
pnpm install
pnpm test
pnpm verify:results
```

Use focused changes. Benchmark harness changes should include tests, and published result bundles should include `manifest.json`, `checksums.txt`, `result.json`, and raw row evidence.

## Result Bundles

Use the benchmark CLI to publish and verify result bundles:

```bash
pnpm benchmark publish-result --run runs/<run-id> --out results/<bundle-id>
pnpm benchmark verify-result results/<bundle-id>
```

Large raw artifacts may be stored as `raw.jsonl.gz`; the manifest records the artifact path and checksum.

## Pull Requests

Pull requests should include:

- A short description of the benchmark, harness, or documentation change.
- Links to any new result bundle directories.
- The exact validation commands run.
- Notes on any provider failures, skipped rows, or known limitations.

Do not commit API keys, local `.env` files, or private evaluation data.
