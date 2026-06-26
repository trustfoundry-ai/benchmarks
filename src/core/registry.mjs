import { publicSearchCaseQuestionsBenchmarkAdapter } from '../adapters/benchmarks/public-search-case-questions.mjs';
import { trustfoundryPublicSearchProviderAdapter } from '../adapters/providers/trustfoundry-public-search.mjs';
import { searchRecallScorerAdapter } from '../adapters/scorers/search-recall.mjs';

export const registry = {
  benchmarks: new Map([
    [publicSearchCaseQuestionsBenchmarkAdapter.id, publicSearchCaseQuestionsBenchmarkAdapter]
  ]),
  providers: new Map([
    [trustfoundryPublicSearchProviderAdapter.id, trustfoundryPublicSearchProviderAdapter]
  ]),
  scorers: new Map([
    [searchRecallScorerAdapter.id, searchRecallScorerAdapter]
  ])
};

export function getAdapter(kind, id) {
  const adapter = registry[kind]?.get(id);
  if (!adapter) throw new Error(`Unknown ${kind} adapter: ${id}`);
  return adapter;
}
