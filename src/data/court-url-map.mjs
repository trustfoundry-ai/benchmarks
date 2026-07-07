/**
 * Court URL map — parses TrustFoundry's court-coverage spreadsheet into a
 * lookup table from `court_id` (the internal identifier that also lives on
 * benchmark rows as `metadata.authority_identifier`) to the primary court
 * website host(s) and full URL(s).
 *
 * Backing data: ships as `src/data/court-url-map.template.csv` — a small
 * starter set covering SCOTUS and the thirteen federal circuits. Users
 * extend by setting the `TF_COURT_URLS_CSV` env var to their own CSV path
 * with the same shape (`Jurisdiction,Court Type,Court Id,Court Name,Court URL`
 * header). No TrustFoundry-internal coverage priorities are shipped.
 *
 * Used by the exa-legal-search adapter to build per-row `includeDomains`
 * scoped to the row's actual jurisdiction, rather than a static allowlist.
 * Also used by the citation-extractor's URL-parser dispatcher (via
 * `listAllHosts()`) to know which host patterns to bother writing.
 *
 * The CSV is loaded lazily on first access and cached for the process
 * lifetime. Reload can be forced with `_reset()` in tests.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_CSV_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'court-url-map.template.csv'
);

let _loaded = null;

// Minimal RFC-4180 CSV parser — handles quoted fields with embedded commas
// and newlines. Matches the parser used in scripts/exa-probe-domain-coverage.mjs
// so behavior is consistent between one-off probes and the harness path.
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
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

function normalizeHost(url) {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function loadFromPath(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(raw);
  // Detect the header row. TF's CSV has an empty spacer row between the
  // header and body, so we scan for the row whose cell 0 is "Jurisdiction".
  const headerIdx = rows.findIndex((r) => (r[0] || '').trim() === 'Jurisdiction');
  if (headerIdx === -1) {
    throw new Error(`court-url-map: header row not found in ${csvPath}`);
  }
  const header = rows[headerIdx];
  const col = {
    jurisdiction: header.indexOf('Jurisdiction'),
    court_type: header.indexOf('Court Type'),
    court_id: header.indexOf('Court Id'),
    court_name: header.indexOf('Court Name'),
    court_url: header.indexOf('Court URL')
  };
  const courtIdToEntry = new Map();
  const allHosts = new Set();
  for (const r of rows.slice(headerIdx + 1)) {
    const cid = (r[col.court_id] || '').trim();
    const url = (r[col.court_url] || '').trim();
    if (!cid || !url || !url.startsWith('http')) continue;
    const host = normalizeHost(url);
    if (!host) continue;
    let entry = courtIdToEntry.get(cid);
    if (!entry) {
      entry = {
        courtId: cid,
        jurisdiction: (r[col.jurisdiction] || '').trim() || null,
        courtType: (r[col.court_type] || '').trim() || null,
        courtName: (r[col.court_name] || '').trim() || null,
        urls: [],
        hosts: new Set()
      };
      courtIdToEntry.set(cid, entry);
    }
    if (!entry.urls.includes(url)) entry.urls.push(url);
    entry.hosts.add(host);
    allHosts.add(host);
  }
  for (const [, v] of courtIdToEntry) v.hosts = Array.from(v.hosts);
  return { courtIdToEntry, allHosts: Array.from(allHosts) };
}

function ensureLoaded() {
  if (_loaded) return _loaded;
  const csvPath = process.env.TF_COURT_URLS_CSV || DEFAULT_CSV_PATH;
  _loaded = loadFromPath(csvPath);
  _loaded.csvPath = csvPath;
  return _loaded;
}

// PUBLIC API

/**
 * Return the array of hosts (e.g. ['courts.michigan.gov']) associated with a
 * given court_id. Empty array if unknown. Case-insensitive lookup.
 */
export function courtIdToHosts(courtId) {
  if (!courtId) return [];
  const { courtIdToEntry } = ensureLoaded();
  const entry = courtIdToEntry.get(String(courtId).trim());
  return entry ? entry.hosts.slice() : [];
}

/**
 * Return all URLs associated with a given court_id. Some courts publish
 * opinions at multiple URLs (e.g. supreme + appellate index pages).
 */
export function courtIdToUrls(courtId) {
  if (!courtId) return [];
  const { courtIdToEntry } = ensureLoaded();
  const entry = courtIdToEntry.get(String(courtId).trim());
  return entry ? entry.urls.slice() : [];
}

/**
 * Return the full entry record { courtId, jurisdiction, courtType, courtName,
 * urls, hosts } for a court_id, or null.
 */
export function courtIdToEntry(courtId) {
  if (!courtId) return null;
  const { courtIdToEntry: map } = ensureLoaded();
  return map.get(String(courtId).trim()) ?? null;
}

/**
 * Return every unique host in the coverage sheet. Used by
 * citation-extractor.mjs to inventory which URL patterns need parsers.
 */
export function listAllHosts() {
  return ensureLoaded().allHosts.slice();
}

/**
 * Return the count of distinct court_ids known — sanity-check for tests.
 */
export function knownCourtIdCount() {
  return ensureLoaded().courtIdToEntry.size;
}

/**
 * Test-only reset. Forces a reload on next access; useful when swapping in
 * a fixture CSV via TF_COURT_URLS_CSV env var.
 */
export function _reset() {
  _loaded = null;
}

// Re-export for tests + probe-script compatibility.
export const _internals = {
  loadFromPath,
  normalizeHost,
  parseCsv
};
