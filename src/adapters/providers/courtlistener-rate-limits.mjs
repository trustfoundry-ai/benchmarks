// CourtListener rate-limit bootstrap + sliding-window scheduler.
//
// Bootstrap: on adapter startup, GET CL's API overview page and parse the
// throttle rates ("5 requests per minute", "50 per hour", "125 per day") out
// of the HTML. If the fetch fails or the parse yields fewer than all three
// numbers, fall back to config-provided defaults. The source ("live" or
// "fallback") plus the resolved numbers are exposed via describe() so the
// manifest and any published result bundle records which limits were in
// effect for the run.
//
// Scheduler: keeps timestamps of every attempted call (successful or not,
// since a 429 still consumed a slot on the server side). Before each call,
// computeSleepMs() returns the minimum wait so that no window is violated
// once the pending call lands. Retry-After / X-RateLimit-Reset response
// headers take precedence when they push further out than our local model.
//
// Safety: isQuotaExhausted() returns true once per_day calls have landed in
// the last 24h. The adapter uses this to fail-fast remaining cases with
// provider_failure kind='quota_exhausted' rather than waiting the full day.

const DEFAULT_DOCS_URL = 'https://wiki.free.law/c/courtlistener/help/api/rest/v4/overview';
const DEFAULT_LIMITS = { per_minute: 5, per_hour: 50, per_day: 125 };
const WINDOW_MS = {
  per_minute: 60_000,
  per_hour: 3_600_000,
  per_day: 86_400_000
};
// When CL's Retry-After / X-RateLimit-Reset pushes serverReset beyond this
// horizon, treat it as an IP-exhaustion signal — return 'server_backoff'
// from exhaustedWindow() so the adapter short-circuits with quota_exhausted
// and the caller switches IPs, instead of sleeping through a multi-hour wait
// (observed: CL sometimes returns Retry-After ≥ 60_000 seconds).
const SERVER_BACKOFF_EXHAUSTION_MS = 5 * 60_000;

// Parses "5 requests per minute", "50 per hour", "125/day", etc. out of
// arbitrary HTML/text. Returns null if any of the three numbers is missing
// so callers can fall through to the fallback path.
export function parseThrottleRates(text) {
  if (typeof text !== 'string' || !text) return null;
  const patterns = [
    ['per_minute', /(\d+)\s*(?:requests?|calls?)?\s*(?:per|\/|a)\s*minute/i],
    ['per_hour', /(\d+)\s*(?:requests?|calls?)?\s*(?:per|\/|an)\s*hour/i],
    ['per_day', /(\d+)\s*(?:requests?|calls?)?\s*(?:per|\/|a)\s*day/i]
  ];
  const out = {};
  for (const [key, re] of patterns) {
    const match = text.match(re);
    if (!match) return null;
    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value) || value <= 0) return null;
    out[key] = value;
  }
  return out;
}

// Fetches the CL docs URL and parses throttle rates out of the body.
// Returns null on any failure (network, non-200, incomplete parse). Safe to
// call in a test with an injected fetchFn.
export async function fetchThrottleRates({
  docsUrl,
  fetchFn = globalThis.fetch,
  timeoutMs = 10_000
} = {}) {
  if (!docsUrl || typeof fetchFn !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(docsUrl, { signal: controller.signal });
    if (!response || !response.ok) return null;
    const text = await response.text();
    return parseThrottleRates(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLimits(limits) {
  const merged = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(WINDOW_MS)) {
    const value = Number.parseInt(String(merged[key] ?? ''), 10);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`CourtListener rate limit ${key} must be a positive integer, got ${merged[key]}`);
    }
    merged[key] = value;
  }
  return merged;
}

export class CourtListenerRateLimiter {
  constructor({ limits, source = 'unknown', docsUrl = null, now = () => Date.now() } = {}) {
    this.limits = normalizeLimits(limits);
    this.source = source;
    this.docsUrl = docsUrl;
    this.now = now;
    this.calls = [];
    this.serverReset = null;
  }

  static async bootstrap({
    docsUrl = DEFAULT_DOCS_URL,
    fallback = DEFAULT_LIMITS,
    fetchFn,
    now,
    onLog
  } = {}) {
    const live = await fetchThrottleRates({ docsUrl, fetchFn });
    if (live) {
      onLog?.(
        `CourtListener rate limits (live from ${docsUrl}): ${JSON.stringify(live)}`
      );
      return new CourtListenerRateLimiter({
        limits: live,
        source: 'live',
        docsUrl,
        now
      });
    }
    onLog?.(
      `CourtListener rate limits: docs fetch failed or parse incomplete for ${docsUrl}, ` +
        `falling back to ${JSON.stringify(fallback)}`
    );
    return new CourtListenerRateLimiter({
      limits: fallback,
      source: 'fallback',
      docsUrl,
      now
    });
  }

  pruneOldCalls() {
    const cutoff = this.now() - WINDOW_MS.per_day;
    while (this.calls.length && this.calls[0] <= cutoff) this.calls.shift();
  }

  isQuotaExhausted() {
    return this.exhaustedWindow() !== null;
  }

  // Returns 'per_hour' or 'per_day' when the corresponding sliding window is
  // full, otherwise null. per_minute is intentionally excluded — waiting up
  // to ~60s for that window to free is cheap and not worth an IP switch.
  // Callers use this to short-circuit remaining cases as provider_failure
  // { kind: 'quota_exhausted' } rather than sleeping through an hour+ wait.
  exhaustedWindow() {
    this.pruneOldCalls();
    const now = this.now();
    for (const key of ['per_hour', 'per_day']) {
      const windowStart = now - WINDOW_MS[key];
      let count = 0;
      for (const timestamp of this.calls) {
        if (timestamp > windowStart) count += 1;
      }
      if (count >= this.limits[key]) return key;
    }
    if (
      this.serverReset !== null &&
      this.serverReset - now > SERVER_BACKOFF_EXHAUSTION_MS
    ) {
      return 'server_backoff';
    }
    return null;
  }

  computeSleepMs() {
    this.pruneOldCalls();
    const now = this.now();
    let sleep = 0;
    for (const key of Object.keys(WINDOW_MS)) {
      const limit = this.limits[key];
      const windowMs = WINDOW_MS[key];
      const windowStart = now - windowMs;
      let earliestInWindow = null;
      let countInWindow = 0;
      for (const timestamp of this.calls) {
        if (timestamp > windowStart) {
          countInWindow += 1;
          if (earliestInWindow === null || timestamp < earliestInWindow) {
            earliestInWindow = timestamp;
          }
        }
      }
      if (countInWindow >= limit && earliestInWindow !== null) {
        const release = earliestInWindow + windowMs - now;
        if (release > sleep) sleep = release;
      }
    }
    if (this.serverReset !== null && this.serverReset > now) {
      const serverSleep = this.serverReset - now;
      if (serverSleep > sleep) sleep = serverSleep;
    }
    return Math.max(0, sleep);
  }

  recordCall(timestampMs) {
    const ts = Number.isFinite(timestampMs) ? timestampMs : this.now();
    this.calls.push(ts);
  }

  applyResponseHeaders(headers) {
    if (!headers) return;
    const getHeader = (name) => {
      if (typeof headers.get === 'function') return headers.get(name);
      return headers[name] ?? headers[name.toLowerCase()] ?? null;
    };
    const retryAfter = getHeader('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      let at = null;
      if (Number.isFinite(seconds) && seconds >= 0) {
        at = this.now() + seconds * 1000;
      } else {
        const parsed = Date.parse(retryAfter);
        if (Number.isFinite(parsed)) at = parsed;
      }
      if (at !== null && (this.serverReset === null || at > this.serverReset)) {
        this.serverReset = at;
      }
    }
    const reset = getHeader('x-ratelimit-reset');
    if (reset) {
      const epoch = Number(reset);
      if (Number.isFinite(epoch)) {
        const at = epoch > 1e12 ? epoch : epoch * 1000;
        if (this.serverReset === null || at > this.serverReset) this.serverReset = at;
      }
    }
  }

  describe() {
    return {
      source: this.source,
      docsUrl: this.docsUrl,
      limits: { ...this.limits }
    };
  }
}

export const _internals = {
  DEFAULT_DOCS_URL,
  DEFAULT_LIMITS,
  WINDOW_MS,
  normalizeLimits
};
