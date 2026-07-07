#!/usr/bin/env node
// build-cl-jurisdictions — download CourtListener's bulk courts + courthouses
// CSVs from CL's public S3 bucket, join them, and write a compact
// `data/courtlistener/court-jurisdictions.json` in the shape the
// `courtlistener-search` adapter expects.
//
// Two files land in `data/courtlistener/` (gitignored):
//   - courts-YYYY-MM-DD.csv         (from CL's search_court table dump)
//   - courthouses-YYYY-MM-DD.csv    (from CL's courthouses table dump)
// Both are cached — reruns reuse them if present. The joined output
// `court-jurisdictions.json` is refreshed on every run.
//
// Usage:
//   node scripts/build-cl-jurisdictions.mjs
//   node scripts/build-cl-jurisdictions.mjs --refresh          # force re-download
//   node scripts/build-cl-jurisdictions.mjs --data-dir <path>
//
// Requires `bunzip2` (or `bzip2`) on PATH — standard on macOS + Linux;
// on Windows use WSL. No CL API rate limits apply — this hits public S3.

import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const S3_BASE = 'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/';
const S3_LIST = `${S3_BASE}?prefix=bulk-data/`;
const DEFAULT_DATA_DIR = 'data/courtlistener';
const OUT_FILENAME = 'court-jurisdictions.json';

// Sanity floors. CL's bulk dumps have ~3300 courts + ~3300 courthouses;
// a hard drop below these bounds means the parser silently corrupted a
// field (e.g. a new escape convention) and produced a nearly-empty output.
// Better to fail loudly than to ship a broken jurisdictions file.
const MIN_COURTS_ROWS = 500;
const MIN_COURTHOUSES_ROWS = 500;

const STATE_JURISDICTIONS = new Set(['S', 'SA', 'SS', 'ST', 'SAG']);
const FEDERAL_JURISDICTIONS = new Set(['F', 'FD', 'FB', 'FS', 'MA']);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dataDir: DEFAULT_DATA_DIR, refresh: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir') { args.dataDir = argv[i + 1]; i += 1; }
    else if (argv[i] === '--refresh') args.refresh = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/build-cl-jurisdictions.mjs [--data-dir <path>] [--refresh]

Downloads CourtListener's bulk courts + courthouses CSVs from S3, joins them,
and writes a court-jurisdictions.json compatible with courtlistener-search.

Options:
  --data-dir <path>   Directory for cached bz2/csv files + output JSON.
                      Default: ${DEFAULT_DATA_DIR}
  --refresh           Re-download the bulk files even if they're cached.
`);
}

// ---------------------------------------------------------------------------
// S3 discovery
// ---------------------------------------------------------------------------

async function listBulkKeys() {
  const response = await fetch(S3_LIST, {
    headers: {
      'User-Agent': 'trustfoundry-ai/benchmarks (build-cl-jurisdictions.mjs)'
    }
  });
  if (!response.ok) {
    throw new Error(`S3 listing failed: HTTP ${response.status} ${response.statusText}`);
  }
  const xml = await response.text();
  const keys = [];
  const keyRe = /<Key>([^<]+)<\/Key>/g;
  let match;
  while ((match = keyRe.exec(xml)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

function pickLatestKey(keys, prefix) {
  // prefix like "bulk-data/courts-" — look for keys matching
  // <prefix>YYYY-MM-DD.csv.bz2 and return the one with the newest date.
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{4}-\\d{2}-\\d{2})\\.csv\\.bz2$`);
  let best = null;
  for (const key of keys) {
    const m = pattern.exec(key);
    if (!m) continue;
    if (!best || m[1] > best.date) best = { key, date: m[1] };
  }
  if (!best) throw new Error(`No bulk file found matching ${prefix}<date>.csv.bz2`);
  return best.key;
}

// ---------------------------------------------------------------------------
// Download + decompress
// ---------------------------------------------------------------------------

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function downloadIfMissing(url, destPath, refresh) {
  if (!refresh && await fileExists(destPath)) {
    process.stderr.write(`Cached: ${destPath}\n`);
    return;
  }
  process.stderr.write(`Downloading ${url}\n  → ${destPath}\n`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  await pipeline(response.body, createWriteStream(destPath));
}

async function decompressBz2(bz2Path, csvPath, refresh) {
  if (!refresh && await fileExists(csvPath)) {
    process.stderr.write(`Cached: ${csvPath}\n`);
    return;
  }
  process.stderr.write(`Decompressing ${bz2Path}\n  → ${csvPath}\n`);
  const out = createWriteStream(csvPath);
  await new Promise((resolve, reject) => {
    const child = spawn('bunzip2', ['-ck', bz2Path], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.pipe(out);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bunzip2 exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180 with quoted fields, embedded commas, and \r\n)
// ---------------------------------------------------------------------------

// Parses CSV supporting both RFC-4180 doubled-quote escapes (`""`) and the
// Postgres COPY backslash-quote convention (`\"`) that CL's bulk dumps use.
// Also handles embedded newlines inside quoted fields.
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '\\' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToRecords(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = r[i] ?? '';
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Build the joined JSON
// ---------------------------------------------------------------------------

function normalizeBool(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 't' || s === 'true' || s === '1';
}

function buildStateMap(courthouseRecords) {
  // court_id → first non-empty US state seen. A court can have multiple
  // courthouses in different states (rare but possible for old federal
  // circuits with multi-state seats); we take the first canonical entry.
  const map = new Map();
  for (const c of courthouseRecords) {
    const courtId = c.court_id?.trim();
    const state = c.state?.trim().toUpperCase();
    const country = c.country_code?.trim().toUpperCase();
    if (!courtId || !state || country !== 'US') continue;
    if (!map.has(courtId)) map.set(courtId, state);
  }
  return map;
}

function buildJurisdictionsJson(courtRecords, stateByCourtId) {
  const states = {};
  const federalCourts = [];
  const stateCourtsWithoutState = [];

  for (const court of courtRecords) {
    const id = court.id?.trim();
    const jurisdiction = court.jurisdiction?.trim().toUpperCase();
    if (!id || !jurisdiction) continue;

    const entry = {
      id,
      full_name: court.full_name?.trim() || court.short_name?.trim() || null,
      jurisdiction,
      in_use: normalizeBool(court.in_use)
    };

    if (STATE_JURISDICTIONS.has(jurisdiction)) {
      const state = stateByCourtId.get(id);
      if (!state) {
        stateCourtsWithoutState.push(id);
        continue;
      }
      entry.court_state = state;
      const bucket = states[state] ??= { court_count: 0, courts: [] };
      bucket.courts.push(entry);
      bucket.court_count += 1;
    } else if (FEDERAL_JURISDICTIONS.has(jurisdiction)) {
      entry.court_state = null;
      federalCourts.push(entry);
    }
    // Non-state, non-federal jurisdictions (e.g. tribal `T`, territory `TS`,
    // committees `C`) are intentionally dropped — the adapter's filter modes
    // don't reference them.
  }

  // Deterministic sort so a fresh build produces byte-stable output.
  for (const bucket of Object.values(states)) {
    bucket.courts.sort((a, b) => a.id.localeCompare(b.id));
  }
  federalCourts.sort((a, b) => a.id.localeCompare(b.id));

  return {
    generated_at: new Date().toISOString(),
    source: {
      bucket: S3_BASE,
      note: 'Built by scripts/build-cl-jurisdictions.mjs from CourtListener\'s public bulk data (search_court + courthouses). Rerun with --refresh to pick up newer CL dumps.'
    },
    state_jurisdictions: [...STATE_JURISDICTIONS].sort(),
    federal_jurisdictions: [...FEDERAL_JURISDICTIONS].sort(),
    states: Object.fromEntries(
      Object.entries(states).sort(([a], [b]) => a.localeCompare(b))
    ),
    federal: {
      court_count: federalCourts.length,
      courts: federalCourts
    },
    unmapped_state_courts: stateCourtsWithoutState.sort()
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }

  const dataDir = path.resolve(process.cwd(), args.dataDir);
  await mkdir(dataDir, { recursive: true });

  process.stderr.write(`Listing bulk-data keys from ${S3_LIST}\n`);
  const keys = await listBulkKeys();
  const courtsKey = pickLatestKey(keys, 'bulk-data/courts-');
  const courthousesKey = pickLatestKey(keys, 'bulk-data/courthouses-');
  process.stderr.write(`Latest courts:      ${courtsKey}\n`);
  process.stderr.write(`Latest courthouses: ${courthousesKey}\n`);

  const courtsBz2 = path.join(dataDir, path.basename(courtsKey));
  const courthousesBz2 = path.join(dataDir, path.basename(courthousesKey));
  const courtsCsv = courtsBz2.replace(/\.bz2$/, '');
  const courthousesCsv = courthousesBz2.replace(/\.bz2$/, '');

  await downloadIfMissing(S3_BASE + courtsKey, courtsBz2, args.refresh);
  await downloadIfMissing(S3_BASE + courthousesKey, courthousesBz2, args.refresh);
  await decompressBz2(courtsBz2, courtsCsv, args.refresh);
  await decompressBz2(courthousesBz2, courthousesCsv, args.refresh);

  process.stderr.write('Parsing CSVs and joining ...\n');
  const [courtsText, courthousesText] = await Promise.all([
    readFile(courtsCsv, 'utf8'),
    readFile(courthousesCsv, 'utf8')
  ]);
  const courtRecords = rowsToRecords(parseCsv(courtsText));
  const courthouseRecords = rowsToRecords(parseCsv(courthousesText));

  if (courtRecords.length < MIN_COURTS_ROWS) {
    throw new Error(
      `Parsed only ${courtRecords.length} courts from ${courtsCsv} (expected >= ${MIN_COURTS_ROWS}). ` +
        `Likely a CSV parser bug — CL may have changed the dump format. Inspect the file directly ` +
        `and adjust parseCsv() before rerunning.`
    );
  }
  if (courthouseRecords.length < MIN_COURTHOUSES_ROWS) {
    throw new Error(
      `Parsed only ${courthouseRecords.length} courthouses from ${courthousesCsv} (expected >= ${MIN_COURTHOUSES_ROWS}). ` +
        `Likely a CSV parser bug — inspect the file and adjust parseCsv() before rerunning.`
    );
  }

  const stateByCourtId = buildStateMap(courthouseRecords);

  const output = buildJurisdictionsJson(courtRecords, stateByCourtId);
  const outPath = path.join(dataDir, OUT_FILENAME);
  const tmpPath = `${outPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  await unlink(outPath).catch(() => {});
  await (await import('node:fs/promises')).rename(tmpPath, outPath);

  const stateCourtCount = Object.values(output.states).reduce((n, s) => n + s.court_count, 0);
  process.stderr.write(
    `Wrote ${outPath}\n` +
      `  courts.csv rows:     ${courtRecords.length}\n` +
      `  courthouses.csv rows: ${courthouseRecords.length}\n` +
      `  states covered:      ${Object.keys(output.states).length}\n` +
      `  state courts:        ${stateCourtCount}\n` +
      `  federal courts:      ${output.federal.court_count}\n` +
      `  unmapped state courts: ${output.unmapped_state_courts.length}\n`
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
