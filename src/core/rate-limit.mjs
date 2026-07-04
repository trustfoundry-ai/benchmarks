/**
 * Client-side rate limiting for benchmark harnesses.
 *
 * Reference implementation of a persistent, per-provider request throttle
 * for use against `api.trustfoundry.ai` or any other rate-limited backend.
 * State is written to disk (`state_path` relative to `repoRoot`) so limits
 * survive process restarts and interleave correctly across concurrent
 * runs of the same provider. The default policy is a UTC-day request
 * budget plus a minimum inter-request delay derived from the configured
 * per-minute rate.
 *
 * Adapters that need to bootstrap limits at runtime (e.g. by reading them
 * from a vendor headers or documentation URL) should wrap this class in a
 * provider-specific limiter that resolves the config first, then hands it
 * to `FileBackedRateLimiter`.
 */
import path from 'node:path';

import { exists, readJson, writeJson } from './fs.mjs';

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function numberConfig(config, snakeKey, camelKey, fallback = null) {
  const value = config?.[snakeKey] ?? config?.[camelKey];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stringConfig(config, snakeKey, camelKey, fallback = null) {
  const value = config?.[snakeKey] ?? config?.[camelKey];
  return value === undefined || value === null || value === ''
    ? fallback
    : String(value);
}

function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(dateMs - Date.now(), 0);
}

function resolveRateConfig(config, { providerId, repoRoot }) {
  const rate = config?.rate_limit ?? config?.rateLimit ?? null;
  if (!rate || rate.enabled === false) return null;

  const requestsPerMinute = numberConfig(rate, 'requests_per_minute', 'requestsPerMinute');
  const requestsPerDay = numberConfig(rate, 'requests_per_day', 'requestsPerDay');
  const configuredMinDelay = numberConfig(rate, 'min_delay_ms', 'minDelayMs', 0);
  const minuteDelay =
    requestsPerMinute && requestsPerMinute > 0
      ? Math.ceil(60000 / requestsPerMinute)
      : 0;
  const minDelayMs = Math.max(configuredMinDelay ?? 0, minuteDelay);
  const stateRel = stringConfig(
    rate,
    'state_path',
    'statePath',
    `.rate-limits/${providerId}.json`
  );
  return {
    requestsPerMinute,
    requestsPerDay,
    minDelayMs,
    statePath: path.isAbsolute(stateRel)
      ? stateRel
      : path.resolve(repoRoot ?? process.cwd(), stateRel)
  };
}

export class FileBackedRateLimiter {
  constructor(config, { providerId, repoRoot, now = () => Date.now() } = {}) {
    this.config = resolveRateConfig(config, { providerId, repoRoot });
    this.now = now;
    this.queue = Promise.resolve();
  }

  get enabled() {
    return Boolean(this.config);
  }

  async readState(nowMs) {
    const day = utcDay(nowMs);
    let state = {};
    if (await exists(this.config.statePath)) {
      state = await readJson(this.config.statePath).catch(() => ({}));
    }
    if (state.day !== day) {
      state = {
        day,
        used: 0,
        lastRequestAtMs: null,
        nextAvailableAtMs: null
      };
    }
    return state;
  }

  async acquire() {
    if (!this.enabled) return { allowed: true, rateLimit: null };
    const run = this.queue.then(() => this.acquireNow());
    this.queue = run.catch(() => {});
    return run;
  }

  async acquireNow() {
    const nowMs = this.now();
    const state = await this.readState(nowMs);
    if (
      this.config.requestsPerDay &&
      this.config.requestsPerDay > 0 &&
      state.used >= this.config.requestsPerDay
    ) {
      await writeJson(this.config.statePath, {
        ...state,
        requestsPerDay: this.config.requestsPerDay,
        minDelayMs: this.config.minDelayMs,
        updatedAt: new Date(nowMs).toISOString()
      });
      return {
        allowed: false,
        reason: 'daily_budget_exhausted',
        retryAfterMs: null,
        rateLimit: {
          statePath: this.config.statePath,
          day: state.day,
          used: state.used,
          requestsPerDay: this.config.requestsPerDay,
          remainingToday: 0
        }
      };
    }

    const nextAvailableAtMs = Math.max(
      state.nextAvailableAtMs ?? 0,
      state.lastRequestAtMs ? state.lastRequestAtMs + this.config.minDelayMs : 0
    );
    const waitMs = Math.max(nextAvailableAtMs - nowMs, 0);
    if (waitMs > 0) await sleep(waitMs);
    const startedAtMs = this.now();
    const nextState = {
      ...state,
      used: (state.used ?? 0) + 1,
      lastRequestAtMs: startedAtMs,
      nextAvailableAtMs: null,
      requestsPerMinute: this.config.requestsPerMinute,
      requestsPerDay: this.config.requestsPerDay,
      minDelayMs: this.config.minDelayMs,
      updatedAt: new Date(startedAtMs).toISOString()
    };
    await writeJson(this.config.statePath, nextState);
    return {
      allowed: true,
      rateLimit: {
        statePath: this.config.statePath,
        day: nextState.day,
        used: nextState.used,
        requestsPerDay: this.config.requestsPerDay,
        remainingToday: this.config.requestsPerDay
          ? Math.max(this.config.requestsPerDay - nextState.used, 0)
          : null,
        waitedMs: waitMs
      }
    };
  }

  async noteProviderResult(providerResult) {
    if (!this.enabled) return;
    const retryMs =
      providerResult?.providerMetadata?.retryAfterMs ??
      providerResult?.rawOutput?.retryAfterMs ??
      retryAfterMs(providerResult?.providerMetadata?.retryAfter);
    if (!retryMs || retryMs <= 0) return;
    const nowMs = this.now();
    const state = await this.readState(nowMs);
    await writeJson(this.config.statePath, {
      ...state,
      nextAvailableAtMs: Math.max(state.nextAvailableAtMs ?? 0, nowMs + retryMs),
      updatedAt: new Date(nowMs).toISOString()
    });
  }
}

export function createProviderRateLimiter({ config, providerId, repoRoot }) {
  const limiter = new FileBackedRateLimiter(config, { providerId, repoRoot });
  return limiter.enabled ? limiter : null;
}

export function rateLimitedProviderResult(benchmarkCase, acquisition) {
  const now = new Date().toISOString();
  return {
    caseId: benchmarkCase.caseId,
    status: 'rate_limited',
    rawOutput: { rateLimit: acquisition.rateLimit },
    finalOutputText: JSON.stringify({
      query: benchmarkCase.prompt,
      results: [],
      result_count: 0
    }),
    artifacts: [],
    providerMetadata: {
      rateLimit: acquisition.rateLimit,
      reason: acquisition.reason
    },
    timing: { startedAt: now, completedAt: now, durationMs: 0 },
    tokenUsage: null,
    retryMetadata: null,
    error: {
      kind: 'rate_limit_budget_exhausted',
      message: 'Provider rate limit budget exhausted for this window'
    }
  };
}

export const _internals = {
  resolveRateConfig,
  retryAfterMs,
  utcDay
};
