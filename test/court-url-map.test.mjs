import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  courtIdToHosts,
  courtIdToUrls,
  courtIdToEntry,
  listAllHosts,
  knownCourtIdCount,
  parseCsv,
  _reset
} from '../src/data/court-url-map.mjs';

const FIXTURE_CSV = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'court-url-map-fixture.csv'
);

let prevEnv;

before(() => {
  prevEnv = process.env.TF_COURT_URLS_CSV;
  process.env.TF_COURT_URLS_CSV = FIXTURE_CSV;
  _reset();
});

after(() => {
  if (prevEnv === undefined) delete process.env.TF_COURT_URLS_CSV;
  else process.env.TF_COURT_URLS_CSV = prevEnv;
  _reset();
});

test('parseCsv handles quoted fields, embedded commas, and empty cells', () => {
  const rows = parseCsv(
    'a,b,c\n' +
    '"one","two, three",three\n' +
    ',,\n' +
    '"quote""inside",plain,\n'
  );
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['one', 'two, three', 'three']);
  assert.deepEqual(rows[2], ['', '', '']);
  assert.deepEqual(rows[3], ['quote"inside', 'plain', '']);
});

test('court-url-map loads the fixture CSV and finds expected court_ids', () => {
  _reset();
  assert.ok(knownCourtIdCount() >= 18, `expected >= 18 courts, got ${knownCourtIdCount()}`);
  assert.deepEqual(courtIdToHosts('mich'), ['courts.michigan.gov']);
  assert.deepEqual(courtIdToHosts('conn'), ['jud.ct.gov']);
  assert.deepEqual(courtIdToHosts('scotus'), ['supremecourt.gov']);
  assert.deepEqual(courtIdToHosts('ca9'), ['ca9.uscourts.gov']);
});

test('courtIdToHosts returns empty array for unknown court_id', () => {
  assert.deepEqual(courtIdToHosts('this-is-not-a-real-court'), []);
  assert.deepEqual(courtIdToHosts(''), []);
  assert.deepEqual(courtIdToHosts(null), []);
  assert.deepEqual(courtIdToHosts(undefined), []);
});

test('courtIdToUrls returns full URLs, not just hosts', () => {
  const urls = courtIdToUrls('mich');
  assert.equal(urls.length >= 1, true);
  assert.equal(urls[0].startsWith('http'), true);
  // Assert on the URL's hostname exactly rather than a bare .includes()
  // check — the substring test would also accept e.g.
  // `https://evil.example/redirect?target=courts.michigan.gov`
  // (CodeQL: incomplete-url-substring-sanitization).
  assert.equal(new URL(urls[0]).hostname, 'courts.michigan.gov');
});

test('courtIdToEntry surfaces jurisdiction / courtType / courtName metadata', () => {
  const entry = courtIdToEntry('mich');
  assert.equal(entry.courtId, 'mich');
  assert.equal(entry.jurisdiction, 'State');
  assert.equal(entry.courtType, 'Supreme');
  assert.match(entry.courtName, /Michigan/);
});

test('listAllHosts returns every unique host across the coverage sheet', () => {
  const hosts = listAllHosts();
  // Anchor to a few known hosts we want URL parsers for.
  const expected = [
    'courts.michigan.gov',
    'jud.ct.gov',
    'supremecourt.gov',
    'supremecourt.ohio.gov',
    'nycourts.gov',
    'govinfo.gov'
  ];
  for (const h of expected) {
    assert.ok(hosts.includes(h), `expected host '${h}' in listAllHosts()`);
  }
});

test('default (shipped template) CSV covers SCOTUS + all thirteen federal circuits', () => {
  const savedEnv = process.env.TF_COURT_URLS_CSV;
  delete process.env.TF_COURT_URLS_CSV;
  _reset();
  try {
    assert.ok(knownCourtIdCount() >= 14, `expected >= 14 courts in template, got ${knownCourtIdCount()}`);
    assert.deepEqual(courtIdToHosts('scotus'), ['supremecourt.gov']);
    assert.deepEqual(courtIdToHosts('ca9'), ['ca9.uscourts.gov']);
    assert.deepEqual(courtIdToHosts('cadc'), ['cadc.uscourts.gov']);
    // Confirm state-level courts are NOT in the shipped template — they're a user extension.
    assert.deepEqual(courtIdToHosts('mich'), []);
  } finally {
    if (savedEnv !== undefined) process.env.TF_COURT_URLS_CSV = savedEnv;
    _reset();
  }
});
