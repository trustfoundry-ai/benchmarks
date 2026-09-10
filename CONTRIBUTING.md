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

Adding a new suite (a benchmark, scorer, dataset, and manifest) is its own
walkthrough — see [`docs/adding-a-suite.md`](docs/adding-a-suite.md).

## Result Bundles

Use the benchmark CLI to publish and verify result bundles:

```bash
pnpm benchmark publish-result --run runs/<run-id> --out results/<bundle-id>
pnpm benchmark verify-result results/<bundle-id>
```

Raw artifacts are stored as `raw.jsonl.gz`; the manifest records the artifact path and checksum.

## Publishing numbers

Publish numbers in a **pull request separate from the harness change that
produced them**:

1. Merge the harness change.
2. Check out a clean `main` — no local modifications.
3. Run the target.
4. Open a second pull request containing only the bundle.

Run `pnpm check:provenance` before opening that pull request. It asserts that
every bundle's `run.harness.commit` is an ancestor of the base branch and that
the tree that produced it was clean. A commit that lives only on a feature
branch, or that a force-push later rewrites, is not something a reader can
check out — and a bundle pinning one is not reproducible.

A published bundle must be a single end-to-end run under the exact
configuration its manifest names. Re-scoring stored responses is the right tool
for analysis; it is not how a published artifact is produced, because
recomputed checksums attest to file integrity rather than provenance.

## Pull Requests

Pull requests should include:

- A short description of the benchmark, harness, or documentation change.
- Links to any new result bundle directories.
- The exact validation commands run.
- Notes on any provider failures, skipped rows, or known limitations.

Do not commit API keys, local `.env` files, or private evaluation data.
