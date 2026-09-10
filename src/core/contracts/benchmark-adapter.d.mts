// Benchmark adapter contract.
//
// A benchmark adapter reads a dataset (JSONL on disk, remote catalog pull,
// synthetic generator, etc.) and returns a normalized array of
// `benchmarkCase` records the runner feeds into a provider.

import type { BenchmarkCase } from './provider-adapter.d.mts';

export interface BenchmarkDescriptor {
  id: string;
  version: string;
  sourceRoot: string;
  sourceCommit?: string | null;
  promptVersion?: string;
  materializationVersion?: string;
  sourceFiles?: string[];
  queryTransformId?: string | null;
}

export interface BenchmarkInventoryRecord {
  id: string;
  benchmark: string;
  status: 'selected' | 'skipped' | 'unsupported' | string;
  selected: boolean;
  skipReasons: string[];
}

export interface BenchmarkInventory {
  benchmark: string;
  sourceRoot: string;
  records: BenchmarkInventoryRecord[];
  summary: {
    total: number;
    selected: number;
    available_skipped: number;
    unsupported: number;
    skipReasons: Record<string, number>;
    [key: string]: unknown;
  };
}

export interface BenchmarkLoadArgs {
  config: Record<string, unknown>;
  repoRoot: string;
}

export interface BenchmarkLoadResult {
  benchmark: BenchmarkDescriptor;
  inventory: BenchmarkInventory;
  cases: BenchmarkCase[];
}

export interface BenchmarkAdapter {
  readonly id: string;
  readonly version: string;
  readonly promptVersion?: string;
  readonly materializationVersion?: string;
  /**
   * Keys of `case.metadata.expected` that must survive into a published
   * bundle's raw rows, for suites whose gold does not fit the fixed
   * single-citation shape the raw-row schema carries by default.
   *
   * Omitting it publishes no extra fields, which is correct for any suite
   * whose gold is a `document_uuid` / `canonical_citation` pair. Declaring it
   * is an allowlist and never a wildcard: `metadata.expected` may hold internal
   * identifiers, and a published bundle is a public artifact.
   */
  readonly publishedExpectedFields?: readonly string[];
  loadCases(args: BenchmarkLoadArgs): Promise<BenchmarkLoadResult>;
}
