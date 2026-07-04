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
  loadCases(args: BenchmarkLoadArgs): Promise<BenchmarkLoadResult>;
}
