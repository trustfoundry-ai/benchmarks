/**
 * Config loading + naming helpers for benchmark harnesses.
 *
 * Reference implementation of the config-loading pattern the runner and
 * CLI use: read JSON from disk, hash it, keep both the raw config and
 * its stable digest around for manifest fingerprinting. `loadConfig`
 * with no path returns the fallback wrapped in the same envelope shape
 * so downstream code can uniformly consume the result.
 */
import path from 'node:path';

import { exists, readJson } from './fs.mjs';
import { hashObject } from './hash.mjs';

export async function loadConfig(configPath, fallback = {}) {
  if (!configPath) {
    return {
      config: fallback,
      configPath: null,
      configHash: hashObject(fallback)
    };
  }
  const resolved = path.resolve(configPath);
  if (!(await exists(resolved))) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const config = await readJson(resolved);
  return {
    config,
    configPath: resolved,
    configHash: hashObject(config)
  };
}

export function normalizeProviderSlug(providerId, config = {}) {
  const model = config.model ?? config.modelId ?? config.exactModelId;
  // Split the anchored dash-trim into two separate replaces so neither
  // regex has an alternation branch — avoids the polynomial-backtracking
  // pattern CodeQL flags (js/polynomial-redos on `/^-+|-+$/g`).
  return [providerId, model]
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .toLowerCase();
}

export function effectiveRunId({ benchmarkId, providerSlug, scorerId }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${benchmarkId}-${providerSlug}-${scorerId}-${timestamp}`;
}
