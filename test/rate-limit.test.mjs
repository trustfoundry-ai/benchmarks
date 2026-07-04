import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  FileBackedRateLimiter,
  createProviderRateLimiter,
  rateLimitedProviderResult
} from '../src/core/rate-limit.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rate-limit-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('file-backed rate limiter enforces and resets daily budget', async () => {
  await withTempDir(async (root) => {
    let now = Date.parse('2026-06-23T12:00:00Z');
    const limiter = new FileBackedRateLimiter(
      {
        rate_limit: {
          requests_per_day: 2,
          min_delay_ms: 0,
          state_path: path.join(root, 'provider-state.json')
        }
      },
      { providerId: 'example-provider', now: () => now }
    );

    assert.equal((await limiter.acquire()).allowed, true);
    assert.equal((await limiter.acquire()).allowed, true);
    const blocked = await limiter.acquire();
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'daily_budget_exhausted');
    assert.equal(blocked.rateLimit.remainingToday, 0);

    now = Date.parse('2026-06-24T00:01:00Z');
    const reset = await limiter.acquire();
    assert.equal(reset.allowed, true);
    assert.equal(reset.rateLimit.day, '2026-06-24');
    assert.equal(reset.rateLimit.remainingToday, 1);
  });
});

test('disabled when config has no rate_limit block', () => {
  const limiter = new FileBackedRateLimiter({}, { providerId: 'x' });
  assert.equal(limiter.enabled, false);
});

test('createProviderRateLimiter returns null when disabled', () => {
  const limiter = createProviderRateLimiter({ config: {}, providerId: 'x' });
  assert.equal(limiter, null);
});

test('rateLimitedProviderResult shape', () => {
  const result = rateLimitedProviderResult(
    { caseId: 'c1', prompt: 'hello' },
    { rateLimit: { remainingToday: 0 }, reason: 'daily_budget_exhausted' }
  );
  assert.equal(result.caseId, 'c1');
  assert.equal(result.status, 'rate_limited');
  assert.equal(result.error.kind, 'rate_limit_budget_exhausted');
  const parsed = JSON.parse(result.finalOutputText);
  assert.equal(parsed.query, 'hello');
  assert.deepEqual(parsed.results, []);
});
