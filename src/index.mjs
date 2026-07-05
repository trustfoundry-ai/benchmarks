/**
 * Public barrel for @trustfoundry-ai/benchmarks-harness.
 *
 * The default entry point exposes the runner, registry, and core
 * helpers used by external consumers building benchmarks against
 * `api.trustfoundry.ai`.
 *
 * Sub-path exports are also available:
 *   - `.../contracts` → adapter factory helpers
 *   - `.../testing`   → fixture helpers + test registry
 *   - `.../cli`       → the CLI entry point
 */
export * from './core/index.mjs';
