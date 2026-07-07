/**
 * Adapter registry for benchmark harnesses.
 *
 * The registry indexes three kinds of adapters — `benchmarks`,
 * `providers`, and `scorers` — by their string `id`. Two entry points:
 *
 * - `defaultRegistry` (also exported as `registry` for backward
 *   compatibility) is pre-populated with the adapters shipped in this
 *   package. External consumers who want to add their own adapters can
 *   call `defaultRegistry.register(kind, adapter)`.
 *
 * - `createRegistry()` returns a fresh empty registry with the same
 *   shape. Useful for tests, or for consumers who want isolation from
 *   the shipped defaults.
 *
 * Adapter shape: each adapter is an object with (at minimum) `id`
 * (string, unique within its kind) and `version` (string). See the
 * factories in `src/core/contracts/index.mjs` for the full contract.
 */
import { trustfoundryCitationLookupBenchmarkAdapter } from '../adapters/benchmarks/trustfoundry-citation-lookup.mjs';
import { trustfoundryLegalSearchBenchmarkAdapter } from '../adapters/benchmarks/trustfoundry-legal-search.mjs';
import { anthropicLegalSearchProviderAdapter } from '../adapters/providers/anthropic-legal-search.mjs';
import { courtlistenerSearchProviderAdapter } from '../adapters/providers/courtlistener-search.mjs';
import { exaLegalSearchProviderAdapter } from '../adapters/providers/exa-legal-search.mjs';
import { openaiLegalSearchProviderAdapter } from '../adapters/providers/openai-legal-search.mjs';
import { trustfoundryLegalSearchProviderAdapter } from '../adapters/providers/trustfoundry-legal-search.mjs';
import { trustfoundryCitationLookupScorerAdapter } from '../adapters/scorers/trustfoundry-citation-lookup.mjs';
import { trustfoundryLegalSearchScorerAdapter } from '../adapters/scorers/trustfoundry-legal-search.mjs';

export function createRegistry() {
  const registry = {
    benchmarks: new Map(),
    providers: new Map(),
    scorers: new Map(),
    register(kind, adapter) {
      if (!registry[kind]) {
        throw new Error(`Unknown adapter kind: ${kind}`);
      }
      if (!adapter?.id) {
        throw new Error(`Adapter is missing 'id' for kind '${kind}'`);
      }
      registry[kind].set(adapter.id, adapter);
      return registry;
    }
  };
  return registry;
}

export const defaultRegistry = createRegistry();
defaultRegistry.register('benchmarks', trustfoundryLegalSearchBenchmarkAdapter);
defaultRegistry.register('benchmarks', trustfoundryCitationLookupBenchmarkAdapter);
defaultRegistry.register('providers', anthropicLegalSearchProviderAdapter);
defaultRegistry.register('providers', courtlistenerSearchProviderAdapter);
defaultRegistry.register('providers', exaLegalSearchProviderAdapter);
defaultRegistry.register('providers', openaiLegalSearchProviderAdapter);
defaultRegistry.register('providers', trustfoundryLegalSearchProviderAdapter);
defaultRegistry.register('scorers', trustfoundryLegalSearchScorerAdapter);
defaultRegistry.register('scorers', trustfoundryCitationLookupScorerAdapter);

// Backwards-compat alias — existing public callers import `registry`.
export const registry = defaultRegistry;

export function getAdapter(kind, id, source = defaultRegistry) {
  const adapter = source[kind]?.get(id);
  if (!adapter) throw new Error(`Unknown ${kind} adapter: ${id}`);
  return adapter;
}

export function getBenchmarkAdapter(id, source = defaultRegistry) {
  return getAdapter('benchmarks', id, source);
}

export function getProviderAdapter(id, source = defaultRegistry) {
  return getAdapter('providers', id, source);
}

export function getScorerAdapter(id, source = defaultRegistry) {
  return getAdapter('scorers', id, source);
}

export function adapterInventory(source = defaultRegistry) {
  return {
    benchmarks: Array.from(source.benchmarks.keys()).sort(),
    providers: Array.from(source.providers.keys()).sort(),
    scorers: Array.from(source.scorers.keys()).sort()
  };
}
