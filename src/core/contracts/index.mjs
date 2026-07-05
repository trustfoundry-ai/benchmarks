/**
 * Adapter contract factories.
 *
 * `defineProviderAdapter` / `defineBenchmarkAdapter` / `defineScorerAdapter`
 * are thin factory helpers that validate the required keys on an adapter
 * definition at construction time and return the input unchanged. They're
 * meant to catch typos and missing keys early — the runtime contract that
 * the runner actually enforces lives in the sibling `.d.mts` files and
 * the runner itself.
 *
 * Usage:
 *
 *   import { defineProviderAdapter } from
 *     '@trustfoundry-ai/benchmarks-harness/contracts';
 *
 *   export const myProvider = defineProviderAdapter({
 *     id: 'my-provider',
 *     version: 'my-provider-v1',
 *     async describe() { ... },
 *     async executeCase({ benchmarkCase, config }) { ... }
 *   });
 */

const REQUIRED_PROVIDER_KEYS = ['id', 'version'];
const REQUIRED_BENCHMARK_KEYS = ['id', 'version'];
const REQUIRED_SCORER_KEYS = ['id', 'version'];

function assertKeys(kind, adapter, requiredKeys) {
  if (adapter === null || typeof adapter !== 'object') {
    throw new Error(`${kind} adapter must be an object`);
  }
  for (const key of requiredKeys) {
    if (adapter[key] === undefined || adapter[key] === null) {
      throw new Error(
        `${kind} adapter is missing required key '${key}'. Adapter: ${JSON.stringify({ id: adapter.id, version: adapter.version })}`
      );
    }
  }
  return adapter;
}

export function defineProviderAdapter(adapter) {
  return assertKeys('Provider', adapter, REQUIRED_PROVIDER_KEYS);
}

export function defineBenchmarkAdapter(adapter) {
  return assertKeys('Benchmark', adapter, REQUIRED_BENCHMARK_KEYS);
}

export function defineScorerAdapter(adapter) {
  return assertKeys('Scorer', adapter, REQUIRED_SCORER_KEYS);
}
