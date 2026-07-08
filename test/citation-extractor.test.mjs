import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseUrl,
  citationToRegex,
  classifyContext,
  findCitationInText,
  findCitationsInText,
  extractCitations,
  slugToBluebook,
  slugToReporter
} from '../src/data/citation-extractor.mjs';

// -----------------------------------------------------------------------
// URL parsers
// -----------------------------------------------------------------------

test('parseUrl extracts cl_cluster_id from CourtListener opinion URLs', () => {
  const out = parseUrl('https://www.courtlistener.com/opinion/6751062/people-schmittdiel/');
  assert.equal(out.parser, 'courtlistener_opinion');
  assert.equal(out.cl_cluster_id, '6751062');
  assert.equal(out.host, 'courtlistener.com');
});

test('parseUrl handles CourtListener /c/ volume-index URLs (no per-case id)', () => {
  const out = parseUrl('https://www.courtlistener.com/c/ohio-cc-dec/29/');
  assert.equal(out.parser, 'courtlistener_reporter_index');
  assert.equal(out.reporter_slug, 'ohio-cc-dec');
  assert.equal(out.volume, '29');
  assert.equal(out.cl_cluster_id, undefined);
});

test('parseUrl on storage.courtlistener.com PDF returns cl_opinion_id (not cluster_id)', () => {
  const out = parseUrl('https://storage.courtlistener.com/harvard_pdf/2018235.pdf');
  assert.equal(out.parser, 'courtlistener_storage_pdf');
  assert.equal(out.cl_opinion_id, '2018235');
  assert.equal(out.cl_pdf_source, 'harvard_pdf');
});

test('parseUrl derives approximate Bluebook citation from Justia case URL slug', () => {
  const out = parseUrl('https://law.justia.com/cases/michigan/supreme-court/1971/386-mich-1-2.html');
  assert.equal(out.parser, 'justia_case');
  assert.equal(out.state, 'michigan');
  assert.equal(out.year, '1971');
  assert.equal(out.bluebook_from_url, '386 Mich. 1');
});

test('parseUrl handles Google Scholar case URLs', () => {
  const out = parseUrl('https://scholar.google.com/scholar_case?case=1234567890&hl=en');
  assert.equal(out.parser, 'google_scholar_case');
  assert.equal(out.google_scholar_case_id, '1234567890');
});

test('parseUrl handles Cornell LII supreme court URLs', () => {
  const out = parseUrl('https://www.law.cornell.edu/supremecourt/text/463/1');
  assert.equal(out.parser, 'cornell_lii_supreme');
  assert.equal(out.bluebook_from_url, '463 U.S. 1');
});

test('parseUrl handles the current /court/ findlaw path prefix', () => {
  // FindLaw's default caselaw URLs today carry an extra "court" segment
  // that the legacy 2-segment regex would miss.
  const out = parseUrl('https://caselaw.findlaw.com/court/mi-court-of-appeals/116326994.html');
  assert.equal(out.parser, 'findlaw_caselaw');
  assert.equal(out.court_slug, 'mi-court-of-appeals');
  assert.equal(out.docket, '116326994');
  assert.equal(out.host, 'caselaw.findlaw.com');
});

test('parseUrl still handles the legacy findlaw path shape (no /court/ prefix)', () => {
  const out = parseUrl('https://caselaw.findlaw.com/mi-supreme-court/1252927.html');
  assert.equal(out.parser, 'findlaw_caselaw');
  assert.equal(out.court_slug, 'mi-supreme-court');
  assert.equal(out.docket, '1252927');
});

test('parseUrl derives Bluebook citation from Justia state direct-reporter URL', () => {
  const out = parseUrl('https://law.justia.com/cases/california/court-of-appeal/4th/64/1190.html');
  assert.equal(out.parser, 'justia_state_reporter');
  assert.equal(out.state, 'california');
  assert.equal(out.court_slug, 'court-of-appeal');
  assert.equal(out.series, '4th');
  assert.equal(out.volume, '64');
  assert.equal(out.page, '1190');
  assert.equal(out.bluebook_from_url, '64 Cal. App. 4th 1190');
});

test('parseUrl leaves bluebook_from_url null for unknown state/court combos', () => {
  const out = parseUrl('https://law.justia.com/cases/texas/thirteenth-court-of-appeals/2d/50/100.html');
  assert.equal(out.parser, 'justia_state_reporter');
  assert.equal(out.state, 'texas');
  assert.equal(out.court_slug, 'thirteenth-court-of-appeals');
  assert.equal(out.bluebook_from_url, null);
});

test('parseUrl derives Bluebook citation from Justia state volumes-path URL', () => {
  const out = parseUrl('https://law.justia.com/cases/massachusetts/supreme-court/volumes/323/323mass79.html');
  assert.equal(out.parser, 'justia_state_volumes');
  assert.equal(out.state, 'massachusetts');
  assert.equal(out.volume, '323');
  assert.equal(out.page, '79');
  assert.equal(out.reporter_slug, 'mass');
  assert.equal(out.bluebook_from_url, '323 Mass. 79');
});

test('parseUrl derives Bluebook citation from Justia federal-appellate URL', () => {
  const out = parseUrl('https://law.justia.com/cases/federal/appellate-courts/F2/841/1281/420797/');
  assert.equal(out.parser, 'justia_federal_appellate');
  assert.equal(out.reporter_slug, 'F2');
  assert.equal(out.volume, '841');
  assert.equal(out.page, '1281');
  assert.equal(out.bluebook_from_url, '841 F.2d 1281');
});

test('parseUrl records docket for Justia federal-district URL without deriving a citation', () => {
  const out = parseUrl('https://law.justia.com/cases/federal/district-courts/michigan/miedce/2:2021cv10750/353419/60/');
  assert.equal(out.parser, 'justia_federal_district');
  assert.equal(out.state, 'michigan');
  assert.equal(out.court_slug, 'miedce');
  assert.equal(out.docket, '2:2021cv10750');
  assert.equal(out.bluebook_from_url, null);
});

test('parseUrl still handles the year-first Justia case shape (justia_case wins)', () => {
  // Regression: adding justia_state_reporter must not swallow the existing
  // {state}/{court}/{year}/{slug}.html shape handled by justia_case.
  const out = parseUrl('https://law.justia.com/cases/mississippi/supreme-court/1966/44190-0.html');
  assert.equal(out.parser, 'justia_case');
  assert.equal(out.state, 'mississippi');
  assert.equal(out.year, '1966');
});

test('parseUrl returns unmatched_host for a host with no dedicated parser', () => {
  const out = parseUrl('https://random.example.com/some/path');
  assert.equal(out.parser, null);
  assert.equal(out.host, 'random.example.com');
  assert.equal(out.unmatched_host, true);
});

test('parseUrl flags primary_court_site for a .gov court host without a parser', () => {
  const out = parseUrl('https://www.courts.michigan.gov/siteassets/case-documents/uploads/opinions/final/sct/166363_52_01.pdf');
  assert.equal(out.parser, 'primary_court_site');
  assert.equal(out.primary_court_site, true);
  assert.equal(out.host, 'courts.michigan.gov');
});

test('slugToBluebook / slugToReporter handle common Justia slug patterns', () => {
  assert.equal(slugToBluebook('386-mich-1-2'), '386 Mich. 1');
  assert.equal(slugToBluebook('123-f2d-456'), '123 F.2d 456');
  assert.equal(slugToReporter('mich'), 'Mich.');
  assert.equal(slugToReporter('f2d'), 'F.2d');
  assert.equal(slugToReporter('so2d'), 'So.2d');
});

// -----------------------------------------------------------------------
// Text scan + context classification
// -----------------------------------------------------------------------

test('citationToRegex tolerates whitespace variance', () => {
  const re = citationToRegex('13 Mich. 233');
  assert.equal(re.test('13 Mich. 233'), true);
  re.lastIndex = 0;
  assert.equal(re.test('13  Mich.  233'), true);
  re.lastIndex = 0;
  assert.equal(re.test('13\tMich.\n233'), true);
});

test('classifyContext returns "reference" when preceded by see/citing/cf/quoting', () => {
  assert.equal(classifyContext('… see also ', ''), 'reference');
  assert.equal(classifyContext('… citing ', ''), 'reference');
  assert.equal(classifyContext('The court, quoting ', ''), 'reference');
  assert.equal(classifyContext('cf. ', ''), 'reference');
  assert.equal(classifyContext('id., ', ''), 'reference');
});

test('classifyContext returns "caption" when preceded by case name or docket', () => {
  assert.equal(classifyContext('People v. Auditors, ', ''), 'caption');
  assert.equal(classifyContext('No. 22-0123, ', ''), 'caption');
  assert.equal(classifyContext(' plaintiff, ', ''), 'caption');
});

test('classifyContext treats short/empty prefix as caption (citation at start)', () => {
  assert.equal(classifyContext('', ''), 'caption');
  assert.equal(classifyContext('  ', ''), 'caption');
});

test('classifyContext falls back to "unknown" for neutral mid-paragraph context', () => {
  assert.equal(
    classifyContext('The proposition below is central to modern county governance. ', ''),
    'unknown'
  );
});

test('findCitationInText locates every occurrence with correct context class', () => {
  const text = 'People ex rel. Schmittdiel v. Board of Auditors, 13 Mich. 233 (1865) ' +
    'established the doctrine. Later, see 13 Mich. 233 (cited in Wayne Circuit).';
  const hits = findCitationInText(text, '13 Mich. 233');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].contextClass, 'caption');
  assert.equal(hits[1].contextClass, 'reference');
});

test('findCitationsInText scans multiple gold citations at once', () => {
  const text = 'This case, 13 Mich. 233, has parallel citation 1865 Mich. LEXIS 19.';
  const hits = findCitationsInText(text, ['13 Mich. 233', '1865 Mich. LEXIS 19']);
  assert.equal(hits.length, 2);
  assert.equal(hits.some((h) => h.citation === '13 Mich. 233'), true);
  assert.equal(hits.some((h) => h.citation === '1865 Mich. LEXIS 19'), true);
});

// -----------------------------------------------------------------------
// extractCitations — full unified path
// -----------------------------------------------------------------------

const GOLD = {
  canonical_citation: '13 Mich. 233',
  alternates: ['1865 Mich. LEXIS 19'],
  cl_cluster_id: '6751062'
};

test('extractCitations strongHit=true when URL cross-refs the gold cl_cluster_id', () => {
  const out = extractCitations({
    url: 'https://www.courtlistener.com/opinion/6751062/people-schmittdiel/',
    text: '',
    gold: GOLD
  });
  assert.equal(out.urlMatchesGold, true);
  assert.equal(out.strongHit, true);
  assert.equal(out.looseHit, true);
});

test('extractCitations strongHit=true when excerpt contains a caption-class match', () => {
  const out = extractCitations({
    url: 'https://law.justia.com/cases/michigan/supreme-court/1865/x-y.html',
    text: 'People ex rel. Schmittdiel v. Board of Auditors, 13 Mich. 233 (1865). ' +
      'The doctrine holds that a county may…',
    gold: GOLD
  });
  assert.equal(out.urlMatchesGold, false);
  assert.equal(out.strongHit, true);
  assert.equal(out.contextBreakdown.caption, 1);
});

test('extractCitations strongHit=false when excerpt only contains a REFERENCE match', () => {
  const out = extractCitations({
    url: 'https://law.justia.com/cases/michigan/supreme-court/1971/386-mich-1-2.html',
    text: 'Wayne Circuit Judges v. Wayne County. The court, citing 13 Mich. 233, held that…',
    gold: GOLD
  });
  assert.equal(out.strongHit, false, 'reference match should not count as strong hit');
  assert.equal(out.looseHit, true, 'reference match should register as loose hit for analysis');
  assert.equal(out.contextBreakdown.reference, 1);
  assert.equal(out.contextBreakdown.caption, 0);
});

test('extractCitations reports both url + excerpt matches with breakdown', () => {
  const out = extractCitations({
    url: 'https://www.courtlistener.com/opinion/6751062/people-schmittdiel/',
    text: 'People ex rel. Schmittdiel v. Board of Auditors, 13 Mich. 233 (1865).',
    gold: GOLD
  });
  assert.equal(out.urlMatchesGold, true);
  assert.equal(out.contextBreakdown.caption, 1);
  assert.equal(out.strongHit, true);
});

test('extractCitations urlMatchesGold=false when CL cluster_id differs from gold', () => {
  const out = extractCitations({
    url: 'https://www.courtlistener.com/opinion/9999999/some-other-case/',
    text: '',
    gold: GOLD
  });
  assert.equal(out.urlMatchesGold, false);
  assert.equal(out.strongHit, false);
});
