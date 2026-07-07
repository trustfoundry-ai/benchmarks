/**
 * Public API surface for `@trustfoundry-ai/benchmarks-harness`.
 *
 * The symbols re-exported from this barrel are the stable public API.
 * They follow semver: additive changes are minor bumps, breaking
 * changes are major bumps. Everything else in `./core/*.mjs` is
 * considered internal and may change without notice — import it via
 * `@trustfoundry-ai/benchmarks-harness/core/<file>` if you must, but
 * don't build against it.
 *
 * Sub-path exports:
 *   - `.../contracts` — adapter factory helpers + `.d.mts` contracts
 *   - `.../testing`   — fixture helpers for adapter tests
 *   - `.../cli`       — the CLI entry point (`main(args)`)
 *
 * See `docs/adapter-contracts.md` for the long-form guide.
 */

// ---- Registry + adapter authoring ----
export {
  adapterInventory,
  createRegistry,
  defaultRegistry,
  getAdapter,
  getBenchmarkAdapter,
  getProviderAdapter,
  getScorerAdapter,
  registry
} from './core/registry.mjs';

export {
  defineBenchmarkAdapter,
  defineProviderAdapter,
  defineScorerAdapter
} from './core/contracts/index.mjs';

// ---- Run entry points ----
export {
  buildReport,
  executeProviderCaseWithRetry,
  executeRun,
  runOpenEvaluation,
  scoreRun
} from './core/runner.mjs';

export { mergeRuns } from './core/merge.mjs';

export {
  casesForRetrySelection,
  defaultRetryFilter,
  isMissScore,
  missScoredCaseIds,
  retryFailed,
  retryFailedRun,
  retryableScoredCaseIds
} from './core/retry-failed.mjs';

// ---- Adapter id resolution + scorer config validation ----
export {
  benchmarkAdapterId,
  maxScorerCutoff,
  providerAdapterId,
  readApiRequestLimit,
  scorerAdapterId,
  validateApiRequestLimitAgainstCutoffs,
  validateScorerCutoffsMatchImplementation
} from './core/runner.mjs';

// ---- Rate limiting reference implementation ----
export {
  FileBackedRateLimiter,
  createProviderRateLimiter,
  rateLimitedProviderResult
} from './core/rate-limit.mjs';

// ---- Token usage aggregation ----
export {
  normalizeTokenUsage,
  summarizeTokenUsage
} from './core/token-usage.mjs';

// ---- Checkpointing ----
export {
  clearCheckpoints,
  loadCaseCheckpoints,
  writeCaseCheckpoint,
  writeCaseProgressCheckpoint
} from './core/checkpoints.mjs';

// ---- Manifest ----
export {
  assertCompatibleManifest,
  buildManifest,
  computeFingerprints
} from './core/manifest.mjs';

// ---- Result artifacts + verification ----
export {
  buildRawRow,
  buildRawRows,
  publishResultBundle,
  readRawJsonl,
  reconstructFromRawRows,
  reconstructPairFromRawRow,
  scoreRawRows,
  verifyResultBundle
} from './core/artifacts.mjs';

// ---- Query transforms (benchmark-side) ----
export {
  STRIP_SYNTHETIC_INSTRUCTION_PREFIXES,
  applyQueryTransform,
  stripSyntheticInstructionPrefixes
} from './core/query-transforms.mjs';

// ---- Filesystem + hash primitives used by adapters ----
export {
  canonicalStringify,
  createJsonlWriter,
  exists,
  readJson,
  readJsonl,
  readJsonlStream,
  relativePath,
  sha256File,
  sha256Text,
  writeJson,
  writeJsonl,
  writeText
} from './core/fs.mjs';

export {
  hashFile,
  hashObject,
  stableJson
} from './core/hash.mjs';

// ---- Citation helpers (benchmark + scorer utilities) ----
export {
  acceptedCitationSet,
  normalizeCitation,
  splitCitationList
} from './core/citations.mjs';

// ---- Scheduler ----
export {
  applyShard,
  mapWithConcurrency,
  normalizeScheduler
} from './core/scheduler.mjs';
