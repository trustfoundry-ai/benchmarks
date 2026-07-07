// TypeScript declarations for the testing barrel
// (`@trustfoundry-ai/benchmarks-harness/testing`). Fixture helpers for
// downstream harness-consumer tests. Kept in sync with
// `src/testing/index.mjs`.

import type {
  AdapterRegistry,
  BenchmarkCase,
  CaseResult,
  ProviderAdapter
} from '../index.d.mts';

export { AdapterRegistry, BenchmarkCase, CaseResult, ProviderAdapter };

export declare function createRegistry(): AdapterRegistry;
export declare const defaultRegistry: AdapterRegistry;

// Alias kept separate from createRegistry so consumers can pin against
// a testing-only surface if it diverges from the runtime factory later.
export declare function createTestRegistry(): AdapterRegistry;

export interface MakeFixtureCaseArgs {
  caseId?: string;
  benchmarkId?: string;
  query?: string;
  metadata?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  scoringHints?: Record<string, unknown>;
}

export interface FixtureCase {
  caseId: string;
  benchmarkId: string;
  query: string;
  metadata: Record<string, unknown>;
  scoringHints: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export declare function makeFixtureCase(args?: MakeFixtureCaseArgs): FixtureCase;

export interface MakeFixtureAdapterArgs {
  id?: string;
  version?: string;
  response?: Partial<CaseResult> & Record<string, unknown>;
}

export declare function makeFixtureAdapter(
  args?: MakeFixtureAdapterArgs
): ProviderAdapter;
