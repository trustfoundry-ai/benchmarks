import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CourtListenerRateLimiter,
  fetchThrottleRates,
  parseThrottleRates,
  _internals
} from '../src/adapters/providers/courtlistener-rate-limits.mjs';

test('parseThrottleRates extracts per-minute/hour/day numbers from prose', () => {
  const text = `
    ### Rate Limits

    Authenticated users may make 5 requests per minute, 50 requests per hour,
    and 125 requests per day.
  `;
  assert.deepEqual(parseThrottleRates(text), {
    per_minute: 5,
    per_hour: 50,
    per_day: 125
  });
});

test('parseThrottleRates handles slash and article forms', () => {
  assert.deepEqual(
    parseThrottleRates('10/minute, 200/hour, 5000/day'),
    { per_minute: 10, per_hour: 200, per_day: 5000 }
  );
});

test('parseThrottleRates returns null when any of the three is missing', () => {
  assert.equal(parseThrottleRates('5 per minute and 50 per hour'), null);
  assert.equal(parseThrottleRates(''), null);
  assert.equal(parseThrottleRates(null), null);
});

test('fetchThrottleRates returns null on non-OK response', async () => {
  const rates = await fetchThrottleRates({
    docsUrl: 'https://example.test/docs',
    fetchFn: async () => ({ ok: false, status: 500, text: async () => '' })
  });
  assert.equal(rates, null);
});

test('fetchThrottleRates returns null on fetch throw', async () => {
  const rates = await fetchThrottleRates({
    docsUrl: 'https://example.test/docs',
    fetchFn: async () => {
      throw new Error('network down');
    }
  });
  assert.equal(rates, null);
});

test('fetchThrottleRates returns parsed rates on success', async () => {
  const rates = await fetchThrottleRates({
    docsUrl: 'https://example.test/docs',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => '5 requests per minute, 50 per hour, 125 per day'
    })
  });
  assert.deepEqual(rates, { per_minute: 5, per_hour: 50, per_day: 125 });
});

test('bootstrap uses live rates when docs fetch succeeds', async () => {
  const limiter = await CourtListenerRateLimiter.bootstrap({
    docsUrl: 'https://example.test/docs',
    fallback: { per_minute: 5, per_hour: 50, per_day: 125 },
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => '7 per minute, 60 per hour, 200 per day'
    }),
    onLog: () => {}
  });
  assert.equal(limiter.source, 'live');
  assert.deepEqual(limiter.limits, { per_minute: 7, per_hour: 60, per_day: 200 });
});

test('bootstrap falls back to config-provided limits when fetch fails', async () => {
  const limiter = await CourtListenerRateLimiter.bootstrap({
    docsUrl: 'https://example.test/docs',
    fallback: { per_minute: 5, per_hour: 50, per_day: 125 },
    fetchFn: async () => ({ ok: false, status: 404, text: async () => '' }),
    onLog: () => {}
  });
  assert.equal(limiter.source, 'fallback');
  assert.deepEqual(limiter.limits, { per_minute: 5, per_hour: 50, per_day: 125 });
});

test('computeSleepMs returns 0 when no calls have been made', () => {
  const limiter = new CourtListenerRateLimiter({
    limits: { per_minute: 5, per_hour: 50, per_day: 125 },
    now: () => 1_000_000
  });
  assert.equal(limiter.computeSleepMs(), 0);
});

test('computeSleepMs sleeps until oldest per_minute call ages out', () => {
  let clock = 1_000_000;
  const limiter = new CourtListenerRateLimiter({
    limits: { per_minute: 5, per_hour: 50, per_day: 125 },
    now: () => clock
  });
  // Record 5 calls at the current instant → per_minute window is full.
  for (let i = 0; i < 5; i += 1) limiter.recordCall(clock);
  clock += 10_000;
  const sleep = limiter.computeSleepMs();
  // Oldest call was at 1_000_000; it exits the per_minute window at
  // 1_000_000 + 60_000 = 1_060_000. Now is 1_010_000. So sleep = 50_000.
  assert.equal(sleep, 50_000);
});

test('computeSleepMs honors the tightest of the three windows', () => {
  let clock = 1_000_000;
  const limiter = new CourtListenerRateLimiter({
    limits: { per_minute: 100, per_hour: 3, per_day: 125 },
    now: () => clock
  });
  // Only per_hour is tight (3 calls). Record 3 calls at t=1_000_000.
  for (let i = 0; i < 3; i += 1) limiter.recordCall(clock);
  clock += 60_000; // 1 minute passes
  const sleep = limiter.computeSleepMs();
  // Oldest call exits per_hour at 1_000_000 + 3_600_000 = 4_600_000.
  // Now is 1_060_000. Sleep = 3_540_000.
  assert.equal(sleep, 3_540_000);
});

test('isQuotaExhausted becomes true once per_day is reached', () => {
  let clock = 1_000_000;
  const limiter = new CourtListenerRateLimiter({
    limits: { per_minute: 100, per_hour: 100, per_day: 3 },
    now: () => clock
  });
  assert.equal(limiter.isQuotaExhausted(), false);
  for (let i = 0; i < 3; i += 1) {
    limiter.recordCall(clock);
    clock += 1;
  }
  assert.equal(limiter.isQuotaExhausted(), true);
});

test('pruneOldCalls drops entries older than the per_day window', () => {
  let clock = 100_000_000;
  const limiter = new CourtListenerRateLimiter({
    limits: { per_minute: 5, per_hour: 50, per_day: 3 },
    now: () => clock
  });
  limiter.recordCall(clock - _internals.WINDOW_MS.per_day - 1); // just aged out
  limiter.recordCall(clock - 10_000); // still in window
  limiter.pruneOldCalls();
  assert.equal(limiter.calls.length, 1);
  assert.equal(limiter.isQuotaExhausted(), false);
});

test('applyResponseHeaders honors Retry-After (seconds) as server reset', () => {
  const clock = 1_000_000;
  const limiter = new CourtListenerRateLimiter({
    limits: { per_minute: 5, per_hour: 50, per_day: 125 },
    now: () => clock
  });
  limiter.applyResponseHeaders(new Map([['retry-after', '90']]));
  // Map has .get() so the header lookup works.
  assert.equal(limiter.serverReset, clock + 90_000);
  assert.equal(limiter.computeSleepMs(), 90_000);
});

test('applyResponseHeaders keeps the later of local and server reset', () => {
  let clock = 1_000_000;
  const limiter = new CourtListenerRateLimiter({
    limits: { per_minute: 5, per_hour: 50, per_day: 125 },
    now: () => clock
  });
  limiter.applyResponseHeaders({ 'retry-after': '10' });
  limiter.applyResponseHeaders({ 'retry-after': '5' });
  assert.equal(limiter.serverReset, clock + 10_000);
});

test('describe surfaces source, docsUrl, and limits for the manifest', async () => {
  const limiter = await CourtListenerRateLimiter.bootstrap({
    docsUrl: 'https://example.test/docs',
    fallback: { per_minute: 5, per_hour: 50, per_day: 125 },
    fetchFn: async () => ({ ok: false, status: 500, text: async () => '' }),
    onLog: () => {}
  });
  const description = limiter.describe();
  assert.equal(description.source, 'fallback');
  assert.equal(description.docsUrl, 'https://example.test/docs');
  assert.deepEqual(description.limits, { per_minute: 5, per_hour: 50, per_day: 125 });
});
