// Scorer adapter contract.
//
// A scorer adapter reads the per-case provider results and produces both
// per-case scores and a summary shape (headline metrics, stratifications,
// execution metadata). Scorers expose two entry points: `score` (array
// form, backward-compatible) and `scoreStream` (streaming, preferred for
// large bundles).

import type { BenchmarkCase, CaseResult } from './provider-adapter.d.mts';

export interface CaseScore {
  caseId: string;
  status: 'scored' | 'unscorable' | 'provider_failure' | string;
  score?: number | null;
  scorePercent?: number;
  scorePoints?: number;
  scoreBand?: 'ideal' | 'acceptable' | 'usable' | 'failure' | string;
  hitRank?: number | null;
  hitAt1?: boolean;
  hitAt5?: boolean;
  hitAt10?: boolean;
  hitAt25?: boolean;
  reciprocalRank?: number;
  [key: string]: unknown;
}

export interface ScorerSummary {
  overallScore?: number | null;
  supportedScore?: number | null;
  headline?: Record<string, unknown>;
  latency_ms?: Record<string, unknown> | null;
  execution?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunManifest {
  runId?: string;
  run_id?: string;
  benchmark?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  scorer?: {
    id?: string;
    version?: string;
    configPath?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ScorerDescribeResult {
  id: string;
  version: string;
  [key: string]: unknown;
}

export interface ScorerValidateConfigArgs {
  scorerConfig: Record<string, unknown>;
}

export interface ScorerScoreArgs {
  manifest: RunManifest | null;
  cases: BenchmarkCase[];
  providerResults: CaseResult[];
}

export interface ScorerScoreStreamArgs {
  manifest: RunManifest | null;
  pairs: AsyncIterable<{ benchmarkCase: BenchmarkCase; providerResult: CaseResult }>;
  onCaseScored?: (arg: {
    benchmarkCase: BenchmarkCase;
    providerResult: CaseResult;
    caseScore: CaseScore;
  }) => Promise<void> | void;
}

export interface ScorerResult {
  scorerId: string;
  status: 'completed' | string;
  caseScores: CaseScore[];
  taskScores?: unknown[];
  summary: ScorerSummary;
  metadata: {
    scorer: string;
    version: string;
    cutoffs?: number[];
    headline_cutoff?: number;
    [key: string]: unknown;
  };
}

export interface ScorerAdapter {
  readonly id: string;
  readonly version: string;
  describe(): Promise<ScorerDescribeResult>;
  score(args: ScorerScoreArgs): Promise<ScorerResult>;
  scoreStream?(args: ScorerScoreStreamArgs): Promise<ScorerResult>;
  // Optional startup-time validation. When present, the runner invokes
  // it before executeRun begins so the scorer can reject configs that
  // would silently produce a result summary the bundle schema cannot
  // represent (e.g. cutoffs that diverge from the scorer's
  // implementation).
  validateConfig?(args: ScorerValidateConfigArgs): void;
}
