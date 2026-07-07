// Hand-authored TypeScript declarations for the public API surface of
// `@trustfoundry-ai/benchmarks-harness`. Kept in lockstep with
// `src/index.mjs` and `test/public-api-surface.test.mjs`.
//
// The declarations here describe the STABLE public API. Every exported
// symbol below must appear in the runtime barrel. If a signature drifts
// from the JS implementation, fix the .d.mts — do not silently narrow
// the runtime.

import type {
  BenchmarkAdapter,
  BenchmarkCase,
  BenchmarkInventory,
  BenchmarkLoadResult,
  CaseResult,
  ProviderAdapter,
  ProviderDescribeResult,
  ProviderTokenUsage
} from './core/contracts/provider-adapter.d.mts';

import type {
  CaseScore,
  RunManifest,
  ScorerAdapter,
  ScorerResult,
  ScorerSummary,
  ScorerValidateConfigArgs
} from './core/contracts/scorer-adapter.d.mts';

// Re-export contract types so consumers can `import type { ... }` from
// the root without also having to know the internal file layout.
export type {
  BenchmarkAdapter,
  BenchmarkCase,
  BenchmarkInventory,
  BenchmarkLoadResult,
  CaseResult,
  ProviderAdapter,
  ProviderDescribeResult,
  ProviderTokenUsage,
  CaseScore,
  RunManifest,
  ScorerAdapter,
  ScorerResult,
  ScorerSummary,
  ScorerValidateConfigArgs
};

// ---- Registry + adapter authoring ----

export type AdapterKind = 'benchmarks' | 'providers' | 'scorers';

export interface AdapterRegistry {
  benchmarks: Map<string, BenchmarkAdapter>;
  providers: Map<string, ProviderAdapter>;
  scorers: Map<string, ScorerAdapter>;
  register(
    kind: AdapterKind,
    adapter: BenchmarkAdapter | ProviderAdapter | ScorerAdapter
  ): AdapterRegistry;
}

export declare function createRegistry(): AdapterRegistry;
export declare const defaultRegistry: AdapterRegistry;
export declare const registry: AdapterRegistry;

export declare function getAdapter<K extends AdapterKind>(
  kind: K,
  id: string,
  source?: AdapterRegistry
): K extends 'benchmarks'
  ? BenchmarkAdapter
  : K extends 'providers'
    ? ProviderAdapter
    : ScorerAdapter;

export declare function getBenchmarkAdapter(
  id: string,
  source?: AdapterRegistry
): BenchmarkAdapter;
export declare function getProviderAdapter(
  id: string,
  source?: AdapterRegistry
): ProviderAdapter;
export declare function getScorerAdapter(
  id: string,
  source?: AdapterRegistry
): ScorerAdapter;

export interface AdapterInventoryResult {
  benchmarks: string[];
  providers: string[];
  scorers: string[];
}
export declare function adapterInventory(source?: AdapterRegistry): AdapterInventoryResult;

export declare function defineBenchmarkAdapter<T extends BenchmarkAdapter>(adapter: T): T;
export declare function defineProviderAdapter<T extends ProviderAdapter>(adapter: T): T;
export declare function defineScorerAdapter<T extends ScorerAdapter>(adapter: T): T;

// ---- Run entry points ----

export interface RunReport {
  runId: string;
  benchmark: Record<string, unknown> | null;
  provider: Record<string, unknown> | null;
  scorer: Record<string, unknown> | null;
  scheduler: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  fingerprints: Record<string, string>;
  preflight: Record<string, unknown> | null;
  providerResults: {
    total: number;
    byStatus: Record<string, number>;
  };
  tokenUsage: Record<string, unknown> | null;
  scores: ScorerSummary | null;
  scorerStatus: string | null;
}

export interface ExecuteRunArgs {
  repoRoot?: string;
  outDir?: string | null;
  outputRoot?: string | null;
  benchmarkConfigPath?: string | null;
  providerConfigPath?: string | null;
  scorerConfigPath?: string | null;
  benchmarkId?: string | null;
  providerId?: string | null;
  scorerId?: string | null;
  limit?: number | null;
  offset?: number | null;
  parallel?: number;
  shardIndex?: number;
  shardCount?: number;
  retries?: number;
  runId?: string | null;
  runKind?: string;
  force?: boolean;
  resume?: boolean;
  progress?: boolean;
  includeHostname?: boolean;
}

export interface ExecuteRunResult {
  outDir: string;
  manifest: RunManifest;
  inventory: BenchmarkInventory;
  preflight: Record<string, unknown> | null;
  providerResults: CaseResult[];
  scores: ScorerResult;
  report: RunReport;
}

export declare function executeRun(args: ExecuteRunArgs): Promise<ExecuteRunResult>;
export declare const runOpenEvaluation: typeof executeRun;

export interface ScoreRunArgs {
  repoRoot: string;
  runDir: string;
}
export declare function scoreRun(args: ScoreRunArgs): Promise<ScorerResult>;

export interface BuildReportArgs {
  manifest: RunManifest;
  preflight: Record<string, unknown> | null;
  scores: ScorerResult;
  providerResults: CaseResult[];
  cases?: BenchmarkCase[];
}
export declare function buildReport(args: BuildReportArgs): RunReport;

export interface ExecuteProviderCaseWithRetryArgs {
  providerAdapter: ProviderAdapter;
  benchmarkCase: BenchmarkCase;
  config: Record<string, unknown>;
  outputRoot: string;
  retries?: number;
  rateLimiter?: FileBackedRateLimiter | null;
}
export declare function executeProviderCaseWithRetry(
  args: ExecuteProviderCaseWithRetryArgs
): Promise<CaseResult>;

// ---- Merge ----

export type MergePolicy = 'first' | 'explicit-run-order' | 'latest' | 'completed';

export interface MergeRunsArgs {
  repoRoot?: string;
  runDirs: string[];
  outDir?: string | null;
  outputRoot?: string | null;
  prefer?: MergePolicy;
  force?: boolean;
}
export interface MergeRunsResult {
  outDir: string;
  manifest: RunManifest;
  cases: BenchmarkCase[];
  providerResults: CaseResult[];
  scores: ScorerResult;
  caseCount: number;
  chunkCount: number;
}
export declare function mergeRuns(args: MergeRunsArgs): Promise<MergeRunsResult>;

// ---- Retry ----

export type RetrySelection = 'failed' | 'misses';

export interface RetryFilterArgs {
  benchmarkCase: BenchmarkCase;
  providerResult: CaseResult | null;
  caseScore: CaseScore | null;
}
export type RetryFilter = (args: RetryFilterArgs) => boolean;

export interface RetryFailedRunArgs {
  repoRoot?: string;
  runDir: string;
  outDir?: string | null;
  outputRoot?: string | null;
  providerConfigPath?: string | null;
  scorerConfigPath?: string | null;
  filter?: RetryFilter | null;
  selection?: RetrySelection;
  parallel?: number;
  retries?: number;
  force?: boolean;
  runId?: string | null;
}
export interface RetryFailedRunResult {
  outDir: string;
  manifest: RunManifest;
  cases: BenchmarkCase[];
  providerResults: CaseResult[];
  scores: ScorerResult;
  report: RunReport;
  caseCount: number;
}
export declare function retryFailedRun(args: RetryFailedRunArgs): Promise<RetryFailedRunResult>;
export declare const retryFailed: typeof retryFailedRun;

export declare const defaultRetryFilter: RetryFilter;
export declare function casesForRetrySelection(args: {
  cases: BenchmarkCase[];
  providerResults: CaseResult[];
  previousScores: ScorerResult | null;
  selection: RetrySelection;
}): BenchmarkCase[];
export declare function isMissScore(score: CaseScore | null | undefined): boolean;
export declare function missScoredCaseIds(scores: ScorerResult | null): Set<string>;
export declare function retryableScoredCaseIds(scores: ScorerResult | null): Set<string>;

// ---- Adapter id resolution + scorer validation ----

export declare function benchmarkAdapterId(config?: Record<string, unknown>): string;
export declare function providerAdapterId(providerConfig?: Record<string, unknown>): string;
export declare function scorerAdapterId(
  benchmarkConfig?: Record<string, unknown>,
  scorerConfig?: Record<string, unknown>
): string;
export declare function maxScorerCutoff(scorerConfig?: Record<string, unknown>): number | null;
export declare function readApiRequestLimit(scorerConfig?: Record<string, unknown>): number | null;
export declare function validateApiRequestLimitAgainstCutoffs(
  scorerConfig?: Record<string, unknown>
): { apiRequestLimit: number | null; maxCutoff: number | null };
export declare function validateScorerCutoffsMatchImplementation(
  scorerConfig?: Record<string, unknown>,
  options?: {
    supportedCutoffs?: readonly number[];
    supportedHeadlineCutoff?: number;
    scorerId?: string;
  }
): void;

// ---- Rate limiting ----

export interface RateLimiterAcquisition {
  allowed: boolean;
  rateLimit?: Record<string, unknown> | null;
  quotaExhausted?: boolean;
  detail?: string;
}

export declare class FileBackedRateLimiter {
  constructor(args: {
    stateFile: string;
    limits: Record<string, unknown>;
    providerId?: string;
  });
  acquire(): Promise<RateLimiterAcquisition>;
  noteProviderResult(result: CaseResult): Promise<void>;
}

export declare function createProviderRateLimiter(args: {
  config: Record<string, unknown>;
  providerId: string;
  repoRoot: string;
}): FileBackedRateLimiter | null;

export declare function rateLimitedProviderResult(
  benchmarkCase: BenchmarkCase,
  acquisition: RateLimiterAcquisition
): CaseResult;

// ---- Token usage ----

export interface TokenUsageSummary {
  total: {
    cases: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cost_usd?: number | null;
  };
  byTask: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export declare function summarizeTokenUsage(args: {
  cases?: BenchmarkCase[];
  providerResults: CaseResult[];
}): TokenUsageSummary;

export declare function normalizeTokenUsage(
  usage: ProviderTokenUsage | null | undefined
): ProviderTokenUsage;

// ---- Checkpointing ----

export interface WriteCaseCheckpointArgs {
  outputRoot: string;
  manifestFingerprint: string;
  benchmarkCase: BenchmarkCase;
  providerResult: CaseResult;
}
export declare function writeCaseCheckpoint(args: WriteCaseCheckpointArgs): Promise<void>;

export interface LoadCaseCheckpointsArgs {
  outputRoot: string;
  manifestFingerprint: string;
}
export interface CaseCheckpoint {
  benchmarkCase: BenchmarkCase;
  providerResult: CaseResult;
}
export declare function loadCaseCheckpoints(
  args: LoadCaseCheckpointsArgs
): Promise<CaseCheckpoint[]>;

export declare function writeCaseProgressCheckpoint(args: {
  outputRoot: string;
  manifest: RunManifest;
  cases: BenchmarkCase[];
  providerResults: CaseResult[];
}): Promise<void>;

export declare function clearCheckpoints(args: { outputRoot: string }): Promise<void>;

// ---- Manifest ----

export interface BuildManifestArgs {
  repoRoot: string;
  runId: string;
  runKind: string;
  benchmark: unknown;
  benchmarkConfig?: Record<string, unknown>;
  providerDescription: ProviderDescribeResult;
  scorerDescription?: { id: string; version?: string; [key: string]: unknown };
  paths: {
    benchmarkConfigFile: string | null;
    providerConfigFile: string | null;
    scorerConfigFile: string | null;
    benchmarkConfigPath?: string | null;
    providerConfigPath?: string | null;
    scorerConfigPath?: string | null;
  };
  parallel: number;
  shardIndex: number;
  shardCount: number;
  retries: number;
  caseCount: number;
  scorerId?: string;
  sourceRuns?: unknown[] | null;
  includeHostname?: boolean;
}
export declare function buildManifest(args: BuildManifestArgs): Promise<RunManifest>;

export declare function computeFingerprints(manifest: RunManifest): Record<string, string>;

export declare function assertCompatibleManifest(
  source: RunManifest,
  candidate: RunManifest,
  options?: { requireResume?: boolean }
): void;

// ---- Artifacts + verification ----

export interface RawRow {
  schema_version: string;
  case_id: string;
  benchmark_id: string | null;
  row_index: number | null;
  split: string | null;
  dataset_name: string | null;
  prompt: string;
  metadata: Record<string, unknown>;
  expected: Record<string, unknown>;
  request: Record<string, unknown> | null;
  response: Record<string, unknown>;
  timing: Record<string, unknown>;
  token_usage: ProviderTokenUsage | null;
  score: Record<string, unknown>;
}

export declare function buildRawRow(args: {
  benchmarkCase: BenchmarkCase;
  providerResult: CaseResult;
  caseScore: CaseScore | null;
}): RawRow;

export declare function buildRawRows(args: {
  cases: BenchmarkCase[];
  providerResults: CaseResult[];
  caseScores: CaseScore[];
}): RawRow[];

export declare function reconstructPairFromRawRow(row: RawRow): {
  benchmarkCase: BenchmarkCase;
  providerResult: CaseResult;
};

export declare function reconstructFromRawRows(rawRows: RawRow[]): {
  cases: BenchmarkCase[];
  providerResults: CaseResult[];
};

export declare function scoreRawRows(args: {
  rawRows: RawRow[];
  manifest?: RunManifest | null;
  scorerId?: string | null;
}): Promise<ScorerResult>;

export declare function readRawJsonl(file: string): Promise<RawRow[]>;

export interface PublishResultBundleArgs {
  repoRoot: string;
  runDir: string;
  outDir: string;
  force?: boolean;
}
export interface PublishResultBundleResult {
  outDir: string;
  manifest: Record<string, unknown>;
  result: Record<string, unknown>;
}
export declare function publishResultBundle(
  args: PublishResultBundleArgs
): Promise<PublishResultBundleResult>;

export interface VerifyResultBundleArgs {
  repoRoot: string;
  bundleDir: string;
  verifyInputs?: boolean;
}
export interface VerifyResultBundleResult {
  ok: true;
  bundleDir: string;
  rows: number;
  summary: ScorerSummary;
}
export declare function verifyResultBundle(
  args: VerifyResultBundleArgs
): Promise<VerifyResultBundleResult>;

// ---- Query transforms ----

export declare const STRIP_SYNTHETIC_INSTRUCTION_PREFIXES: string;

export declare function applyQueryTransform(
  transformId: string | null | undefined,
  input: string
): string;

export declare function stripSyntheticInstructionPrefixes(input: string): string;

// ---- Filesystem primitives ----

export declare function readJson<T = unknown>(path: string): Promise<T>;
export declare function readJsonl<T = unknown>(path: string): Promise<T[]>;
export declare function readJsonlStream<T = unknown>(path: string): AsyncIterable<T>;
export declare function writeJson(path: string, value: unknown): Promise<void>;
export declare function writeJsonl(path: string, rows: unknown[]): Promise<void>;
export declare function writeText(path: string, text: string): Promise<void>;
export declare function exists(path: string): Promise<boolean>;
export declare function relativePath(from: string, to: string): string;

export interface JsonlWriter {
  write(row: unknown): Promise<void>;
  close(): Promise<void>;
}
export declare function createJsonlWriter(path: string): Promise<JsonlWriter>;

export declare function sha256File(path: string): Promise<string>;
export declare function sha256Text(text: string): string;
export declare function canonicalStringify(value: unknown): string;

// ---- Hash primitives ----

export declare function stableJson(value: unknown): string;
export declare function hashObject(value: unknown): string;
export declare function hashFile(path: string): Promise<string>;

// ---- Citation helpers ----

export declare function acceptedCitationSet(input: unknown): Set<string>;
export declare function normalizeCitation(input: string | null | undefined): string;
export declare function splitCitationList(input: string | null | undefined): string[];

// ---- Scheduler ----

export interface Scheduler {
  parallel: number;
  shardIndex: number;
  shardCount: number;
  retries: number;
  caseCount?: number;
}

export declare function normalizeScheduler(args: {
  parallel?: number;
  shardIndex?: number;
  shardCount?: number;
  retries?: number;
}): Scheduler;

export declare function applyShard<T>(items: T[], scheduler: Scheduler): T[];

export declare function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]>;
