#!/usr/bin/env node
// build-cl-jurisdictions — fetch the current CourtListener courts list from
// CL's public REST API and write it as `data/courtlistener/court-jurisdictions.json`
// in the shape the `courtlistener-search` adapter expects.
//
// Usage:
//   node scripts/build-cl-jurisdictions.mjs
//   node scripts/build-cl-jurisdictions.mjs --out data/courtlistener/court-jurisdictions.json
//   node scripts/build-cl-jurisdictions.mjs --token "$COURTLISTENER_API_TOKEN"
//
// The output is derived entirely from CL's public /api/rest/v4/courts/
// endpoint (paginated JSON). No credentials required — a token is only
// used if provided, to unlock the higher authenticated rate limit.
//
// Why this exists: the `courtlistener-search` adapter can scope each row's
// query to state supreme + appellate courts (or federal courts) using a
// court-id -> jurisdiction letter mapping. That mapping isn't shipped
// with the repo; you generate it locally with this script. If the mapping
// file is absent, the adapter still runs — just without jurisdiction
// filtering (broader net, slightly lower precision).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CourtListenerRateLimiter } from '../src/adapters/providers/courtlistener-rate-limits.mjs';

const DEFAULT_OUT = 'data/courtlistener/court-jurisdictions.json';
const CL_COURTS_ENDPOINT = 'https://www.courtlistener.com/api/rest/v4/courts/';
const PAGE_SIZE = 100;
const MAX_RETRIES = 6;

const STATE_JURISDICTIONS = new Set(['S', 'SA', 'SS', 'ST', 'SAG']);
const FEDERAL_JURISDICTIONS = new Set(['F', 'FD', 'FB', 'FS', 'MA']);

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, token: process.env.COURTLISTENER_API_TOKEN ?? null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { args.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--token') { args.token = argv[i + 1]; i += 1; }
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/build-cl-jurisdictions.mjs [--out <path>] [--token <cl-token>]

Downloads the CourtListener courts list via the public REST API and writes
a court-jurisdictions.json compatible with the courtlistener-search adapter.

Options:
  --out <path>    Output path (default: ${DEFAULT_OUT})
  --token <tok>   Optional CL API token for higher rate limits.
                  Falls back to $COURTLISTENER_API_TOKEN.
`);
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function fetchPageWithRetry(url, headers, limiter) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    // Honor sliding-window + Retry-After / X-RateLimit-Reset budgets before firing.
    const sleepMs = limiter.computeSleepMs();
    if (sleepMs > 0) {
      process.stderr.write(`  waiting ${sleepMs}ms for CL rate limiter to open a slot\n`);
      await sleep(sleepMs);
    }
    if (limiter.isQuotaExhausted()) {
      throw new Error(
        `CourtListener quota exhausted (${limiter.exhaustedWindow()} window). ` +
          `Wait for the window to reset, or rerun with --token to raise the limits.`
      );
    }
    let response;
    try {
      response = await fetch(url, { headers });
      limiter.recordCall(Date.now());
      limiter.applyResponseHeaders(response.headers);
    } catch (err) {
      lastError = `fetch threw: ${err?.message ?? err}`;
      continue;
    }
    if (response.ok) return await response.json();
    if (response.status !== 429 && (response.status < 500 || response.status >= 600)) {
      throw new Error(`CourtListener responded ${response.status} ${response.statusText} for ${url}`);
    }
    lastError = `HTTP ${response.status} ${response.statusText}`;
    process.stderr.write(`  attempt ${attempt + 1}/${MAX_RETRIES + 1} — ${lastError} (rate limiter will schedule the next attempt)\n`);
  }
  throw new Error(`CourtListener request failed after ${MAX_RETRIES + 1} attempts: ${lastError} (${url})`);
}

async function fetchAllCourts(token) {
  const headers = {
    'User-Agent': 'trustfoundry-ai/benchmarks (build-cl-jurisdictions.mjs)',
    Accept: 'application/json'
  };
  if (token) headers.Authorization = `Token ${token}`;

  const limiter = await CourtListenerRateLimiter.bootstrap({
    onLog: (msg) => process.stderr.write(`${msg}\n`)
  });

  const all = [];
  let nextUrl = `${CL_COURTS_ENDPOINT}?page_size=${PAGE_SIZE}`;
  let page = 0;

  while (nextUrl) {
    page += 1;
    process.stderr.write(`Fetching page ${page}: ${nextUrl}\n`);
    const body = await fetchPageWithRetry(nextUrl, headers, limiter);
    if (!Array.isArray(body?.results)) {
      throw new Error(`Unexpected response shape from ${nextUrl}: no results array`);
    }
    all.push(...body.results);
    nextUrl = body.next ?? null;
  }
  return all;
}

function normalizeCourt(court) {
  const id = typeof court.id === 'string' ? court.id.trim() : null;
  const jurisdiction = typeof court.jurisdiction === 'string' ? court.jurisdiction.trim().toUpperCase() : null;
  const courtState = typeof court.court_state === 'string' ? court.court_state.trim().toUpperCase() : null;
  if (!id || !jurisdiction) return null;
  return {
    id,
    full_name: court.full_name || court.short_name || null,
    jurisdiction,
    court_state: courtState || null,
    in_use: Boolean(court.in_use)
  };
}

function group(courts) {
  const states = {};
  const federalCourts = [];
  for (const court of courts) {
    if (STATE_JURISDICTIONS.has(court.jurisdiction) && court.court_state) {
      const bucket = states[court.court_state] ??= { court_count: 0, courts: [] };
      bucket.courts.push(court);
      bucket.court_count += 1;
    } else if (FEDERAL_JURISDICTIONS.has(court.jurisdiction)) {
      federalCourts.push(court);
    }
  }
  // Deterministic sort so re-running the script produces a stable file.
  for (const bucket of Object.values(states)) {
    bucket.courts.sort((a, b) => a.id.localeCompare(b.id));
  }
  federalCourts.sort((a, b) => a.id.localeCompare(b.id));
  return {
    generated_at: new Date().toISOString(),
    source: {
      endpoint: CL_COURTS_ENDPOINT,
      note: 'Derived from CourtListener\'s public REST API by scripts/build-cl-jurisdictions.mjs. Rerun to refresh.'
    },
    state_jurisdictions: [...STATE_JURISDICTIONS].sort(),
    federal_jurisdictions: [...FEDERAL_JURISDICTIONS].sort(),
    states: Object.fromEntries(
      Object.entries(states).sort(([a], [b]) => a.localeCompare(b))
    ),
    federal: {
      court_count: federalCourts.length,
      courts: federalCourts
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }

  const rawCourts = await fetchAllCourts(args.token);
  process.stderr.write(`Fetched ${rawCourts.length} raw court records.\n`);

  const normalized = rawCourts.map(normalizeCourt).filter(Boolean);
  process.stderr.write(`Retained ${normalized.length} courts with id + jurisdiction.\n`);

  const output = group(normalized);
  const outPath = path.resolve(process.cwd(), args.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  const stateCourtCount = Object.values(output.states).reduce((n, s) => n + s.court_count, 0);
  process.stderr.write(
    `Wrote ${outPath}\n` +
      `  states: ${Object.keys(output.states).length}\n` +
      `  state courts: ${stateCourtCount}\n` +
      `  federal courts: ${output.federal.court_count}\n`
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
