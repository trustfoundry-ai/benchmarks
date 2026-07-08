# Changelog

All notable, publication-relevant changes to the benchmarks harness and datasets are recorded here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.

## [Unreleased]

## [0.10.0] - 2026-07-08

Fifth vendor provider adapter shipped (`parallel-legal-search`), plus a
batch of citation-extractor URL-parser additions that improve scoring
precision for both the new adapter and the pre-existing `exa-legal-search`.
The adapter-authoring skill is also promoted alongside — checked in for
both Claude Code (`.claude/skills/`) and OpenAI Codex (`.agents/skills/`)
conventions.

No dataset, scored-metric, or result-bundle changes. Every previously-published bundle still verifies byte-for-byte.

### Added

- **`parallel-legal-search` provider adapter.** Wraps [Parallel's
  `/v1/search`](https://docs.parallel.ai/api-reference/search/search) API. Ships
  with `domain_scope: aggregators_only` as the default, mirroring the shipped
  `exa-legal-search` config so the two vendors are directly comparable. Exposes
  Parallel's `mode` (`turbo` / `basic` / `advanced`) and `objective` fields as
  config knobs; the shipped config sets `mode: "advanced"` and a legal-scoping
  `objective`. Same URL-and-excerpt citation-extraction pathway as
  `exa-legal-search` (via `src/data/citation-extractor.mjs`).
- **Provider config** `configs/providers/parallel-legal-search-aggregators-only.json`
  and **benchmark config** `configs/benchmarks/parallel-legal-search-aggregators-only/case-questions-200.json`.
- **Primary-only provider + benchmark configs**
  (`configs/providers/parallel-legal-search-primary-only.json` and
  `configs/benchmarks/parallel-legal-search-primary-only/case-questions-200.json`).
  Diagnostic ablation: restricts `include_domains` per-row to the row's own
  issuing court's `.gov` site via `src/data/court-url-map.mjs`. Not shipped
  as a default (opt-in via config), same shape as the exa diagnostic variants.
- **`docs/adapters/parallel-legal-search.md`** — per-adapter README mirroring
  the Exa doc's structure.
- **25 new tests** in `test/parallel-legal-search-provider.test.mjs`
  covering request-body construction, envelope normalization, citation
  extraction, executeCase full path, API-key redaction, Parallel's 422
  validation-error surface, and timeout classification.
- **`.claude/skills/legal-search-adapter/SKILL.md` and
  `.agents/skills/legal-search-adapter/SKILL.md`** — coding-agent walkthrough
  for adding a new legal-search provider adapter. Same body checked in twice
  under Claude Code's and OpenAI Codex's respective conventions. README's
  "Extending" section gains a "Coding-agent skill" subsection pointing at
  both.

### Changed

- **Citation-extractor URL parsers.** Extended `src/data/citation-extractor.mjs`
  to parse the URL shapes FindLaw and Justia serve today that the shipped
  parsers didn't previously cover. New parsers: `findlaw_supreme_us` (US
  Reports), `justia_state_reporter` (California-style direct-reporter),
  `justia_state_volumes` (Massachusetts-style filename-encoded citations),
  `justia_federal_appellate` (F.2d / F.3d), `justia_federal_reporter_district`
  (F.Supp. / F.Supp.2d / F.Supp.3d). Extended parsers: `findlaw_caselaw`
  accepts the current `/court/` path prefix; `justia_supreme_us` accepts
  the `/case.pdf` suffix; `justia_state_reporter` accepts `supp{N}` page
  suffix; `justia_case` no longer requires the `.html` extension. Also
  seeds `STATE_COURT_REPORTERS` with California, New York, Illinois, and
  Massachusetts. 14 new tests in `test/citation-extractor.test.mjs`.
  Effect: on a 200-row Parallel smoke, 81% of returned URLs parsed cleanly
  and 121 of them derived a Bluebook citation directly from the URL, up
  from prior negligible coverage on those hosts.

### Fixed

- **`justia_federal_district` parser mis-classifying reporter-indexed URLs.**
  URLs of shape `/cases/federal/district-courts/FSupp2/{vol}/{page}/{opinion-id}/`
  were being swallowed as if `FSupp2` were a state slug and `{vol}` were a
  court slug — dropping the derivable Bluebook citation on the floor. Added
  a new `justia_federal_reporter_district` parser matched first (uppercase
  reporter slugs starting with `F`), and tightened `justia_federal_district`
  to only match lowercase state slugs so it can't swallow reporter URLs
  again. `federalReporterFromSlug` extended to translate `FSupp` / `FSupp2` /
  `FSupp3` to `F. Supp.` / `F. Supp. 2d` / `F. Supp. 3d`.

### CI

- **`.github/codeql/codeql-config.yml`** — layered on `security-and-quality`
  with a `query-filter` excluding `js/incomplete-url-substring-sanitization`.
  That rule fires on `Array.prototype.includes` calls against hostname
  allowlists in adapter tests (`domains.includes('courtlistener.com')` —
  element-equality, not URL-substring matching). Six exa-test alerts and
  seven parallel-test alerts had already been dismissed with this
  rationale; the config filter prevents future adapter tests from
  regenerating the same false-positive class. Safe to exclude repo-wide:
  no src/ code performs URL-substring sanitization on user-controlled
  input. `.github/workflows/codeql.yml` updated to wire the config via
  `config-file:`.

## [0.9.1] - 2026-07-07

Post-review hardening pass ahead of design-partner access. No dataset,
scored-metric, or result-bundle changes; every previously-published
bundle still verifies byte-for-byte.

### Removed

- **`trustfoundry-citation-lookup` benchmark, scorer, provider config, dataset,
  suite doc, and registry entries** — pulled from the public repo pending
  full end-to-end validation (PR #14). The companion `courtlistener-citation-lookup`
  provider is also unshipped (still private-only). Both will return together
  as a `0.10.0` release once the flow is vetted. Nothing that was published
  under `results/` referenced this suite.

### Fixed

- **`writeArtifacts` — reject absolute artifact paths.**
  `docs/adapter-contracts.md` documented that the runner rejects `..` segments
  *and* absolute paths, but the code only checked for `..`. Now enforces both
  with a resolved-path check so an adapter emitting an absolute artifact path
  can't write outside the run dir. No in-tree adapter hit this path, so no
  behavior change for shipped runs.
- **CourtListener adapter — allowlist response headers captured in audit
  artifacts.** `raw-responses/*.json` audit artifacts ship inside published
  bundles. The previous wildcard header capture would have preserved any
  header CL (or a proxy) chose to emit. Filtered to the small set actually
  needed for the audit trail (rate-limit family, `Retry-After`, `Date`,
  `Content-*`).

### Changed

- **Anthropic + OpenAI provider configs pin `temperature: 0`.** Reduces
  sampling variance between runs. Adapter passthrough was already correct;
  configs now explicitly set the field, with a `_reproducibility_note` sibling
  documenting what is and isn't pinned. Vendor stochasticity (model-snapshot
  floating, tool-use nondeterminism, live web-search index) remains.
- **CourtListener adapter — file-header comment reworded.** The prior
  "apples-to-apples" phrasing implied parity across every registered provider;
  the actual jurisdictional-scope parity is only with the TrustFoundry
  legal-search provider. Reworded to reflect that.

### Documentation

- **Exa adapter README overhauled.** Adds a Configuration modes table
  labeling each `(domain_scope, query_mode)` combination as ordinary
  measurement / diagnostic / sanity-check so the non-headline modes cannot
  be mistaken for real measurements. Documents each aggregator host and
  why it's on/off the default list; documents `type: 'auto'` semantics;
  spells out the strong-hit / loose-hit citation-extraction boundary.
- **LLM + Exa adapter READMEs reframed as reference implementations.**
  Removes "publishing evaluation numbers" / "reproduce the qualitative
  comparison" / "headline number we publish" phrasing. Adds explicit
  "TrustFoundry is not publishing head-to-head numbers against this
  adapter" disclaimers. Drops specific per-run quality percentages from
  prior TrustFoundry runs; keeps cost / latency envelope guidance so
  evaluators can plan runs.
- **README reproducibility claim softened.** Previous "reproducible
  byte-for-byte" language wasn't literally true for LLM-backed adapters.
  Reworked to describe reproducibility as a layered guarantee (code +
  config + dataset + captured vendor response), with a new
  **Reproducibility model** section in `docs/adapter-contracts.md` spelling
  out what is and isn't pinned at each layer.
- **Suite README — data provenance paragraph.** Notes that all four
  datasets are TrustFoundry-generated synthetic queries held out from
  TrustFoundry's own training set; the bundle publish date marks first
  public appearance.

### Governance

- **`.github/workflows/ci.yml` — pin least-privilege `permissions:
  { contents: read }`.** Brings ci.yml in line with `codeql.yml` and
  `release.yml`, which already had explicit permissions blocks.

## [0.9.0] - 2026-07-07

Vendor provider adapters promoted from the private `benchmarks-lab`
overlay. No dataset or scored-metric changes: every previously-published
result bundle still verifies byte-for-byte.

### Added

- **`courtlistener-search` provider adapter.** Wraps CourtListener's v4
  opinion-search API. Legal-specific search engine; natural apples-to-apples
  comparison to `trustfoundry-legal-search`. Reads rate limits live from
  CourtListener's docs page at startup; honors `Retry-After` /
  `X-RateLimit-Reset` on 429.
- **`anthropic-legal-search` provider adapter.** Wraps Anthropic's
  Messages API with the built-in `web_search_20250305` tool. Three shipped
  provider configs cover Haiku / Sonnet / Opus. Ships as a **qualitative
  demonstrator**, not a competing product — makes the "general LLM +
  web-search vs legal-specific search" gap reproducible against the
  200-row benchmark.
- **`openai-legal-search` provider adapter.** Wraps OpenAI's Responses
  API with the built-in `web_search` tool. Also supports MCP tool
  configuration as an extension capability (unit-tested; not yet
  exercised at 200-row scale). Same qualitative-demonstrator framing.
- **`exa-legal-search` provider adapter.** Wraps Exa's `/search` API.
  Ships with `domain_scope: aggregators_only` as the default — no
  per-row court-coverage map required, portable out of the box. The
  adapter's other modes (`primary_only`, `primary_plus_aggregators`,
  `unrestricted`) rely on `src/data/court-url-map.mjs` +
  `court-url-map.template.csv` (starter set: SCOTUS + 13 federal
  circuits) and can be extended with a user-provided CSV via
  `TF_COURT_URLS_CSV`.
- **Provider configs** for all promoted adapters under
  `configs/providers/`; **benchmark configs** for the LLM/Exa adapters
  under `configs/benchmarks/{anthropic,openai,exa}-legal-search*/`
  (a single `case-questions-200.json` per variant; use CLI
  `--offset` / `--limit` for smokes and subsets).
- **`docs/adapters/`** — per-adapter READMEs documenting integration
  approach, known shortcomings, and (for the LLM/Exa demonstrators)
  the qualitative-comparison framing.
- **`src/data/citation-extractor.mjs` + `src/data/court-url-map.mjs`**
  — per-URL citation parsing and court_id → host resolution helpers
  used by the exa adapter.
- **~160 new tests** across the new adapters + citation-extractor +
  court-url-map. Full public suite: 304/304 green.

### Registry

- `defaultRegistry` gains registrations for the four new provider
  adapters (`anthropic-legal-search`, `courtlistener-search`,
  `exa-legal-search`, `openai-legal-search`) alongside the existing
  `trustfoundry-legal-search`.

### Governance

- CourtListener adapter outbound `User-Agent` uses a role alias
  (`benchmarks@trustfoundry.ai`) per the amended promotion checklist,
  not personal contact info.
- CourtListener quota-exhaustion error message describes the
  header-driven cooldown (`Retry-After` / `X-RateLimit-Reset`) rather
  than any IP-rotation strategy the adapter does not use.

## [0.8.0] - 2026-07-07

General maintainability pass on the harness. No dataset or scored-metric
changes: every previously-published result bundle still verifies
byte-for-byte.

### Added

- **Hand-authored TypeScript declarations for the public API.** New
  `src/index.d.mts` (root barrel), `src/core/index.d.mts` (core
  sub-path), and `src/testing/index.d.mts` (fixture helpers). Package
  now advertises `"types"` on every `exports` conditional so consumers
  get autocomplete and `--strict` type-check on `defineProviderAdapter`,
  `executeRun`, `RateLimiter`, `sha256Text`, and the rest of the
  public surface. `pnpm typecheck` script + `typescript@^5` devDep.
- **`test/public-api-surface.test.mjs`** — snapshot of the exact
  set of keys exported from `src/index.mjs`. Fails on drift so
  additions to the public API become an explicit, reviewable act.
- **Coverage reporting via c8.** `pnpm test:coverage` writes an
  lcov report to `coverage/lcov.info` which CI uploads as an
  artifact. No coverage gate this release — reporting only.
- **`pnpm lint`** — minimal ESLint flat config (`@eslint/js`
  recommended, one no-unused-vars tweak). Runs on every PR.
- **`.github/dependabot.yml`** — weekly grouped npm and github-actions
  updates.
- **`.github/workflows/codeql.yml`** — CodeQL analysis on push, PR,
  and weekly, with the `security-and-quality` query pack.
- **SLSA build-provenance attestations on tagged releases.** The
  release workflow now packs a tarball via `pnpm pack`, attests it
  with `actions/attest-build-provenance@v1`, and attaches the
  tarball to the GitHub release so consumers can
  `gh attestation verify` the bytes they run against.
- **`CITATION.cff`** at the repo root.
- **`results/trustfoundry-legal-search/latest.json`** — stable
  JSON pointer from each `(type, size)` to the currently-published
  dated bundle. Verified by `pnpm verify:results`.
- **`.dockerignore`** — keeps `runs/`, `results/`, `.env*`, `.git/`,
  `test/`, `docs/`, and editor state out of the image.

### Changed

- **`src/core/` no longer names the trustfoundry-legal-search
  adapter.** Cutoff-vs-implementation validation moved onto the
  scorer adapter via an optional `validateConfig({ scorerConfig })`
  method (declared in the scorer-adapter contract). The runner
  calls it during startup validation instead of pulling scorer
  constants across the framework boundary. All `DEFAULT_*`
  fallbacks that pointed at trustfoundry-legal-search were
  removed from `runner.mjs`, `artifacts.mjs`, `manifest.mjs`,
  `merge.mjs`, and `retry-failed.mjs`; each now throws a helpful
  error naming the registered adapter ids when the config leaves
  the id unset. CLI operational defaults (`BENCHMARK_CONFIG` etc.)
  moved from `runner.mjs` to `cli.mjs`. `validateScorerCutoffsMatchImplementation`
  is now defined in a leaf module (`src/core/scorer-validators.mjs`)
  and re-exported from `runner.mjs` for backward compat.
- **`src/index.mjs` is now an explicit named-export list, not
  `export * from './core/index.mjs'`.** The stable public surface
  is the 76 names snapshotted in `test/public-api-surface.test.mjs`;
  additions require an explicit list edit + test update.
  `src/core/index.mjs` still re-exports everything internal, but
  its header comment now warns that not every symbol is public.
- **Dockerfile layer order** — `package.json` + `pnpm-lock.yaml`
  now copy in before `pnpm install --frozen-lockfile` so a `src/`
  edit no longer busts the install cache. Removed the redundant
  `chmod +x entrypoint.sh` step (the file carries `100755` in git).
- **`entrypoint.sh` discovers configs from disk.** The hardcoded
  `ALL_CONFIGS` list is replaced by a `find configs/benchmarks
  -name '*-200.json' -o -name '*-5k.json'` walk; adding a new
  benchmark config no longer requires editing the shell script.
- **CI runs lint, typecheck, and coverage** in addition to
  `pnpm test` + `pnpm verify:results`.
- **PR template** — the "no third-party vendor product names"
  checkbox is split into two: an unchanged ban on internal
  infrastructure names (`data-plane`, `index`, `query-service`,
  internal hostnames) and an explicit allowance for vendor
  product names in adapters or configs specifically evaluating
  that vendor. Plus a new role-alias User-Agent rule.

### Documentation

- **New `## Why this exists` section in `README.md`.** Two
  subsections: transparency and governance for published metrics
  (why the harness exists at all), and why a legal-search
  benchmark specifically (gap analysis vs. LegalBench and
  Harvey LAB).
- **`## Public API` section in `README.md`** listing the stable
  surface groups and pointing at `docs/adapter-contracts.md` for
  semantics.
- **`### Verifying releases`** subsection under Manifest And
  Reproducibility, with the `gh attestation verify` recipe.
- **`## Repository Layout`** now labels `suites/` as
  documentation-only (adapters live under `src/adapters/`) and
  points at `results/<benchmark>/latest.json` for external
  consumers who want a stable "latest" URL.
- **`src/core/contracts/README.md`** — outdated "Adapter
  factories (coming in Phase 3)" section rewritten to describe
  the shipped factories and point at `docs/adapter-contracts.md`.
- **Suite README** picks up a "Latest bundles" one-liner
  pointing at the pointer file.
- **`.github/CODEOWNERS`** — TODO comment at top to revisit at
  3+ maintainers (personal handles become a bottleneck fast).

<!-- Below: changes that had accumulated in the [Unreleased] block
     during the pre-0.8.0 refactor cycle. Rolled into this release. -->

- **Repository layout restructured to group by suite.** Every
  suite-specific artifact now lives under a `trustfoundry-<suite>/`
  path so `configs/`, `data/`, `src/adapters/`, `suites/`, and `test/`
  all read the same way:
  - `configs/benchmarks/trustfoundry-legal-search/<variant>.json` and
    `configs/benchmarks/trustfoundry-citation-lookup/<variant>.json`.
  - `configs/providers/trustfoundry-{legal-search,citation-lookup}.json`.
  - `configs/scorers/trustfoundry-{legal-search,citation-lookup}.json`.
  - `data/trustfoundry-legal-search/{case_questions,case_key_facts,laws,regs}.jsonl`
    (renamed from `data/trustfoundry-legal-search-5k/`) and
    `data/trustfoundry-citation-lookup/{cases,statutes,regulations,negatives}/dataset.jsonl`.
  - `suites/trustfoundry-{legal-search,citation-lookup}/README.md`.
  - `test/adapters/{benchmarks,providers,scorers}/*.test.mjs` mirrors
    the `src/` layout; framework tests stay flat at `test/` root.
  - `entrypoint.sh` `BENCHMARK_CONFIG` env var takes the subpath form
    (e.g. `trustfoundry-legal-search/case-questions-200`).
- **Adapter renames** (file + id):
  - Provider `trustfoundry-public-search` → `trustfoundry-legal-search`.
  - Scorer `search-recall` → `trustfoundry-legal-search`.
  - Scorer `citation-lookup` → `trustfoundry-citation-lookup`.
  - Benchmark `citation-lookup` → `trustfoundry-citation-lookup`.
- **Published result bundles regenerated** against the renamed
  adapters so every `manifest.json` and `result.json` under `results/`
  references the new adapter ids. Bundle SHAs, `checksums.txt`, and
  the surface metrics in `result.json` all reflect the fresh
  2026-07-05 runs against the same live public search API.
- **Result bundle path layout restructured** so bundles group by
  suite and by date. New layout:
  `results/<benchmark>/<yyyy-mm-dd>/<type>/<size>/` (e.g.
  `results/trustfoundry-legal-search/2026-07-05/case-questions/5k/`).
  Previous layouts (`<suite-id>/<provider-id>/<yyyy-mm-dd>-<run-leaf>`
  and later `<suite-id>/<yyyy-mm-dd>/<run-leaf>`) collapsed the
  per-subject dirs into one benchmark family and separated `<type>`
  from `<size>` at their own levels so directory listings sort
  cleanly. The provider that produced the bundle is recorded inside
  the bundle's `manifest.json` (`manifest.provider.id`); it doesn't
  live in the path. Verification is location-independent —
  `checksums.txt` and `manifest.artifacts.*.path` reference file
  names only, so relocating a bundle within `results/` doesn't affect
  `pnpm verify:results`.
- Dropped `configs/benchmarks/trustfoundry-legal-search/case-questions-20.json`
  — a 200-row config is fast enough for smoke and keeps the config
  set tighter.
- Dropped `configs/providers/trustfoundry-citation-lookup-local.json`
  — was an internal-only localhost variant that shouldn't have shipped
  publicly.

<!-- Documentation continues below (rolled up from the pre-0.8.0
     [Unreleased] block). -->

- New `docs/adapter-contracts.md` — long-form guide to the three
  adapter kinds, the four artifact schemas, and the versioning rules.
  Referenced from `src/core/contracts/README.md`.
- `README.md` gains a pre-1.0 status banner and a per-suite status
  table so readers can see at a glance which suites have published
  evaluation numbers (`trustfoundry-legal-search`) vs. which are in
  development (`trustfoundry-citation-lookup`). `docs/adapter-contracts.md` gains a
  matching pre-1.0 notice about contract stability.

### Governance

- `.github/CODEOWNERS` now routes `src/core/**`, `src/core/contracts/**`,
  `data/**`, `results/**`, `suites/**`, `docs/adapter-contracts.md`,
  and `.github/**` to the core maintainers so contract-affecting
  changes cannot merge without a maintainer review.
- New `.github/pull_request_template.md` — checklist covering local
  `pnpm test` / `pnpm verify:results`, schema-version bumps,
  `CHANGELOG.md` entries, and documentation updates.

## [0.7.1] - 2026-07-04

### Added

- Every run's `manifest.json` now records `harness.originUrl`
  (`https://github.com/trustfoundry-ai/benchmarks.git`) alongside
  `harness.commit` and `harness.version` so consumers can reconstruct
  the exact reproduction recipe from the manifest alone. Existing
  bundle checksums are unaffected; new runs pick up the field
  automatically.

### Documentation

- README documents the `manifest.harness` fields and the three
  fingerprints (compatibility / resume / manifest) so external
  consumers understand the reproducibility model.

## [0.7.0] - 2026-07-04

### Changed

- **Runner unified.** `executeRun` now materializes provider results in
  memory, writes per-case checkpoints under
  `<outDir>/checkpoints/cases/*.json`, supports `--resume` against a
  compatible source manifest, and emits `preflight.json`,
  `report.json`, `token-usage.json`, and `<parent>/latest.json`
  alongside `manifest.json` / `provider-results.jsonl` /
  `scores.json`. The pre-refactor streaming-to-disk model is retired
  along with the per-case artifact behaviour it duplicated. Artifact
  materialization (with path-traversal rejection) is preserved.
  `runOpenEvaluation` is exported as an alias of `executeRun` for
  callers migrating from the private runner.
- **Manifest schema** now emits three fingerprints
  (`compatibility` / `resume` / `manifest`) instead of one. Identity
  inputs additively include `benchmark.sourceCommit`,
  `benchmark.promptVersion`, `benchmark.materializationVersion`,
  `provider.subject`, `provider.model`, and
  `scorer.extractionVersion`. Field names (`configSha256`,
  `sourceFiles`) are unchanged so `publishResultBundle` /
  `verifyResultBundle` continue to write and verify bundles
  byte-for-byte. Old bundles' frozen `manifest.json` files still
  verify green under `pnpm verify:results`.
- **Retry unified.** `retryFailedRun` supersedes `retryFailed`
  (retained as an alias) and adds a `selection` mode (`'failed'` or
  `'misses'`) alongside the existing `filter` callback.
  `retry-misses` CLI subcommand added. Retries reuse the runner's
  per-case checkpoints so an interrupted retry can resume.
- **Checkpoints** moved from `src/core/checkpoint.mjs` (class-based
  `CheckpointStore`) to `src/core/checkpoints.mjs` (functional
  `writeCaseCheckpoint` / `loadCaseCheckpoints` /
  `writeCaseProgressCheckpoint` / `clearCheckpoints`). Checkpoints
  now carry the resume fingerprint from the manifest so a resume
  against a different run's directory is caught before any work is
  duplicated.
- **CLI**: `pnpm benchmark run` learns `--benchmark`, `--provider`,
  `--scorer`, `--resume`, `--shard-index`, `--shard-count`, and
  `--retries`. `score` learns `--scorer` / `--scorer-config` to
  rescore an existing run with a different scorer. New `retry-misses`
  and `report` subcommands. `merge` accepted as an alias for
  `merge-runs`.

### Added

- **`./core` and `./core/*` sub-path exports** on the harness package
  so consumers can import specific core modules by name (e.g.
  `import { runOpenEvaluation } from '@trustfoundry-ai/benchmarks-harness/core/runner'`).
- **`buildReport`** and **`executeProviderCaseWithRetry`** exported
  from the runner barrel for consumers that want to compose their
  own run loop.

## [0.6.0] - 2026-07-04

### Changed

- **Package renamed** from `@trustfoundry-ai/benchmarks` to
  `@trustfoundry-ai/benchmarks-harness`. The `-harness` suffix signals
  that this package ships the benchmark harness (runner, contracts,
  helpers) rather than just benchmark data. Downstream consumers can
  update their `package.json` in a single line change.
- **`package.json` gains an `exports` map** so consumers can import
  from sub-paths: `@trustfoundry-ai/benchmarks-harness/contracts`,
  `.../testing`, `.../adapters/registry`, `.../artifacts`, `.../cli`.
- **`src/index.mjs`** is the new default entry point and re-exports
  from `src/core/index.mjs`.
- **`src/core/registry.mjs`** now exports `defaultRegistry` (the
  pre-populated registry) and `createRegistry()` (a factory for
  producing a fresh empty registry). The existing `registry` export
  remains as an alias of `defaultRegistry` for backward compatibility.
  `getBenchmarkAdapter`, `getProviderAdapter`, `getScorerAdapter`, and
  `adapterInventory` are exported alongside the pre-existing
  `getAdapter(kind, id)` so downstream consumers can use whichever
  ergonomics they prefer.

### Added

- **Adapter factory helpers** (`src/core/contracts/index.mjs`):
  `defineProviderAdapter`, `defineBenchmarkAdapter`, and
  `defineScorerAdapter`. Thin factories that validate required keys
  (`id`, `version`) at construction time and return the adapter
  unchanged. Consumers can now write
  `defineProviderAdapter({ id, version, executeCase })` for early
  validation of adapter definitions.
- **Testing barrel** (`src/testing/index.mjs`): `makeFixtureCase`,
  `makeFixtureAdapter`, `createTestRegistry`, plus re-exports of
  `createRegistry` and `defaultRegistry`. Downstream test suites can
  build fixtures without reaching into internal core modules.
- **Core helpers ported to public** as reference implementations:
  - `src/core/scheduler.mjs` — `normalizeScheduler`, `applyShard`,
    `mapWithConcurrency`, `positiveInteger`, `nonNegativeInteger`.
  - `src/core/hash.mjs` — `stableJson`, `hashObject`, `hashFile`
    (plus a re-export of `sha256Text` from `fs.mjs`).
  - `src/core/config.mjs` — `loadConfig`, `normalizeProviderSlug`,
    `effectiveRunId`.
  - `src/core/git.mjs` — `gitRevision`.
- **`.github/workflows/release.yml`** — on a `v*.*.*` tag push, runs
  `pnpm test` + `pnpm verify:results` and publishes a GitHub release
  with auto-generated notes. No npm publish yet.

## [0.5.0] - 2026-07-04

### Added

- **Framework helpers** as reference implementations for anyone building
  a benchmark harness against `api.trustfoundry.ai`:
  - `FileBackedRateLimiter` / `createProviderRateLimiter` /
    `rateLimitedProviderResult` (`src/core/rate-limit.mjs`) — persistent
    per-provider request throttling backed by JSON state on disk.
  - `retryFailed` / `defaultRetryFilter` (`src/core/retry.mjs`) — reissue
    misses from a completed run into a new run directory, using the
    source run's provider + scorer configs and asserting manifest
    compatibility fingerprints match.
  - `summarizeTokenUsage` / `normalizeTokenUsage`
    (`src/core/token-usage.mjs`) — per-task token accounting summaries.
  - `CheckpointStore` (`src/core/checkpoint.mjs`) — per-case atomic
    checkpointing so a crashed run can resume without reissuing
    already-completed cases.
  - `buildManifest` / `computeFingerprints` / `assertCompatibleManifest`
    (`src/core/manifest.mjs`) — run manifest builder + fingerprint
    helpers used by retry and merge to refuse operations across
    incompatible runs.
- **Barrel export**: `src/core/index.mjs` re-exports the new modules
  alongside the pre-existing runner / registry / artifacts helpers so
  external consumers can import from a single entry point.
- **CLI**: `pnpm benchmark retry-failed --run DIR --out DIR [--parallel N]
  [--force]` reissues misses from a completed run.
- **CLI**: `merge-runs` learns `--prefer <policy>` for duplicate-caseId
  resolution (`explicit-run-order` default, `latest`, `first`,
  `completed`). Every merge now emits a `merge-report.json` file
  alongside the merged bundle with input runs, prefer policy, and any
  conflicts observed.
- **Manifests** additively carry `runKind`, `harness.version`, and a
  `fingerprints.compatibility` hash over benchmark / provider / scorer
  identity fields. Existing scoring, reporting, and bundle verification
  behavior is unchanged.

### Changed

- **Runner**: manifest construction extracted from `runner.mjs` into
  `src/core/manifest.mjs`. `runner.mjs::executeRun` now calls
  `buildManifest` from the new module. Output shape gains the additive
  fields above; existing consumers ignoring unknown fields see no
  behavioral change.
- **Runner**: `mergeRuns` extracted from `runner.mjs` into
  `src/core/merge.mjs`. `runner.mjs` still re-exports `mergeRuns` so
  `import { mergeRuns } from '.../core/runner.mjs'` keeps working.

## [0.4.0] - 2026-07-04

### Added

- **New suite: `trustfoundry-citation-lookup`.** Four public datasets under
  `data/citation-lookup-{cases,statutes,regulations,negatives}/` totaling
  4,618 rows. Measures rank-1 citation-lookup accuracy on clean, sloppy,
  and reporter-variation citation surfaces (positives) plus false-positive
  rate on held-out non-citation strings (negatives). New benchmark loader
  (`src/adapters/benchmarks/trustfoundry-citation-lookup.mjs`) and per-benchmark scorer
  (`src/adapters/scorers/trustfoundry-citation-lookup.mjs`) with citation-first matching
  and a generic native-`cluster_id` fallback. Five benchmark configs plus
  a scorer config live under `configs/`. See
  [`suites/citation-lookup/README.md`](suites/citation-lookup/README.md).
- **Dataset**: `expected.cl_cluster_id` field on every case-law row in
  `data/trustfoundry-legal-search-5k/case_questions.jsonl` and
  `case_key_facts.jsonl`. 100% coverage on both files (10,000 rows total).
  Enables native-ID matching for adapters whose results carry a top-level
  `cluster_id`.
- **`--offset N` flag** on `pnpm benchmark run` and a **`merge-runs`
  subcommand** to combine multiple chunked runs into one canonical run
  directory. Both are strictly additive; existing invocations are
  unaffected (offset defaults to 0).

### Changed

- **Runner**: scorer selection is now dynamic. The scorer id is read from
  the benchmark config's `scorer` field (or the scorer config's `id`
  field), defaulting to `trustfoundry-legal-search` when both are omitted. The cutoffs
  validator now consults the selected scorer's exported
  `SUPPORTED_CUTOFFS` / `SUPPORTED_HEADLINE_CUTOFF`, so scorers with
  different K values (e.g. `trustfoundry-citation-lookup` with headline `hit@1`) can
  register without a runner change. Existing configs and result bundles
  continue to work unchanged.
- **Artifacts**: `publishResultBundle` and `verifyResultBundle` also read
  the scorer id dynamically (from `manifest.scorer.id` and
  `result.run.scorer.id` respectively). Existing bundles without those
  fields fall back to `trustfoundry-legal-search` and continue to verify.
- **Scorer** (`trustfoundry-legal-search`): matches native IDs first (`document_uuid`,
  then `cluster_id`), falls back to citation matching. The hit@K math
  is unchanged — any match at rank K still counts — but the code path
  makes the priority explicit and immune to citation-normalization drift.
- **Raw-row schema** (`trustfoundry.benchmarks.raw-row.v1`): additively
  gains optional `expected.cl_cluster_id`, `expected.kind`,
  `expected.negative_category`, and `metadata.{document_type, difficulty,
  kind, negative_category, geo_level_2}` fields so citation-lookup
  bundles preserve stratification-relevant metadata on the roundtrip.
  Older bundles that lack the fields verify unchanged (missing → null).
- **Result envelope** (`trustfoundry.benchmarks.result.v1`): additively
  records `run.scorer` so `verify-result` can pick the correct scorer
  when recomputing summaries. Existing bundles without `run.scorer` fall
  back to `trustfoundry-legal-search`.

### Notes for auditors and downstream consumers

- The 4 checked-in TrustFoundry result bundles for `case-questions` and
  `case-key-facts` (200 + 5k of each) record the *pre-enrichment* data-file
  sha256 in their `manifest.verification_inputs.data_files`. The CI verify
  path (`pnpm verify:results`) still passes because it runs with
  `verifyInputs: false` (it verifies the internal raw→result consistency
  only). Running `pnpm benchmark verify-result <bundle>` directly *will*
  report a data-file sha mismatch until those bundles are regenerated
  against the enriched dataset. Laws/regs bundles are untouched (their
  data files were not modified).
- TrustFoundry scores on the legal-search suite are unchanged by the
  cluster_id enrichment: TF provider results match via `document_uuid`
  (unchanged) and do not populate a `cluster_id` on returned rows. The
  new `cl_cluster_id` field is consulted only when a result exposes one.
- The manifest `scorer.id` string was already recorded on every existing
  bundle as `"trustfoundry-legal-search"`; the runner and artifacts pipeline changes
  keep writing that value for legal-search runs. Only new suites with a
  different `scorer` field in their benchmark config will produce
  bundles with a different `scorer.id`.
