// Provider adapter contract.
//
// A provider adapter is the piece that talks to an external system (LLM
// API, search API, local fixture, etc.) and returns a normalized per-case
// result the framework can feed into a scorer.

export interface BenchmarkCase {
  caseId: string;
  benchmarkId: string;
  taskId?: string | null;
  split?: string | null;
  prompt: string;
  attachments?: unknown[];
  expectedAnswer?: unknown;
  allowedAnswers?: unknown[];
  metadata?: Record<string, unknown> & {
    datasetIndex?: number | null;
    datasetName?: string | null;
    expected?: Record<string, unknown> | null;
    document_uuid?: string | null;
  };
  scoringHints?: Record<string, unknown>;
}

export interface ProviderTiming {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ttfbMs?: number | null;
  streamDurationMs?: number | null;
  serverResponseDurationMs?: number | null;
}

export interface ProviderTokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cost_usd?: number | null;
}

export interface ProviderError {
  kind: string;
  message: string;
  status?: number | null;
}

export interface CaseResult {
  caseId: string;
  status: 'completed' | 'provider_failure' | string;
  rawOutput?: unknown;
  finalOutputText?: string;
  artifacts?: Array<{ path: string; content: string | Buffer }>;
  providerMetadata?: Record<string, unknown> | null;
  timing: ProviderTiming;
  tokenUsage?: ProviderTokenUsage | null;
  retryMetadata?: Record<string, unknown> | null;
  error?: ProviderError | null;
}

export interface ProviderDescribeArgs {
  config: Record<string, unknown>;
}

export interface ProviderDescribeResult {
  id: string;
  version: string;
  target?: string | null;
  tokenEnv?: string | null;
  apiKeyEnv?: string | null;
  settings?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ProviderExecuteArgs {
  benchmarkCase: BenchmarkCase;
  config: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly version: string;
  describe(args: ProviderDescribeArgs): Promise<ProviderDescribeResult>;
  executeCase(args: ProviderExecuteArgs): Promise<CaseResult>;
}
