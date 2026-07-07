/**
 * Citation extractor for legal search results.
 *
 * The scorer wants to know two things about each result Exa/Parallel returns:
 *  1. Does the URL directly identify the target case? (highest-precision)
 *  2. Does the excerpt contain the gold citation, and if so — is it the
 *     result page's OWN citation (a "caption" appearance) or a reference
 *     the page cites (a "reference" appearance)?
 *
 * A reference match must NOT count as a hit: if the returned page is
 * "Wayne Circuit Judges v. Wayne County" and it cites "13 Mich. 233" in
 * passing, that page is not the 1865 case. Only caption / URL matches
 * count.
 *
 * This module exports two orthogonal capabilities:
 *
 *  - URL parsers (per host). Each parser matches a URL path pattern and
 *    extracts identifying info (`cl_cluster_id`, `case_id`, or a Bluebook
 *    citation directly). Only CourtListener's `/opinion/{cluster_id}/`
 *    pattern gives us a direct cross-ref to the gold `cl_cluster_id`;
 *    others yield partial info that's useful for provenance but not for
 *    direct matching.
 *
 *  - Text scan for a specific gold citation string, with context capture
 *    (`~120` chars on each side) and classification into
 *    `caption` | `reference` | `unknown`.
 */

// Phrases that, when they appear within ~40 chars before a citation,
// strongly suggest the citation is a REFERENCE (the page is citing this
// case in passing, not being this case). Extend as needed based on
// unmatched examples in run bundles.
const REFERENCE_MARKERS = [
  'see also',
  'see, e.g.',
  'see, generally',
  'see generally',
  'see id.',
  'see supra',
  'see infra',
  'see, further',
  'see',
  'citing',
  'cited',
  'cf\\.',
  'cf ',
  'quoting',
  'quoted in',
  'compare',
  'accord',
  'e\\.g\\.',
  'contra',
  'but see',
  'but cf\\.',
  'noted in',
  'noting',
  'discussed in',
  'accord,',
  'id\\.',
  'ibid\\.',
  'supra',
  'infra'
];

const REFERENCE_MARKER_RE = new RegExp(
  '(^|[\\s,;\\(\\[])(' + REFERENCE_MARKERS.join('|') + ')[\\s,\\)\\.]{0,3}$',
  'i'
);

// Phrases that suggest the citation IS a caption (this is the page's own
// case). Weaker than reference markers but useful for tie-breaking.
const CAPTION_HINTS_BEFORE = [
  ' v\\. ',   // case name pattern
  ' v ',
  'plaintiff',
  'defendant',
  'appellant',
  'appellee',
  'petitioner',
  'respondent',
  'no\\.\\s+\\d',    // docket number
  'docket'
];
const CAPTION_HINT_BEFORE_RE = new RegExp('(' + CAPTION_HINTS_BEFORE.join('|') + ')', 'i');

// -----------------------------------------------------------------------
// URL parsers
// -----------------------------------------------------------------------

// Each parser is { hostMatch(host), parse(url, pathname, searchParams) }.
// First matching parser wins. Order by specificity.
const URL_PARSERS = [
  {
    name: 'courtlistener_opinion',
    hostMatch: (h) => h === 'courtlistener.com' || h === 'www.courtlistener.com',
    parse: (_url, pathname) => {
      const m = /\/opinion\/(\d+)(?:\/|$)/.exec(pathname);
      if (!m) return null;
      return { cl_cluster_id: m[1], source: 'url_parse', host: 'courtlistener.com' };
    }
  },
  {
    name: 'courtlistener_reporter_index',
    // e.g. /c/ohio-cc-dec/29/ — volume-level index, no per-case ID
    hostMatch: (h) => h === 'courtlistener.com' || h === 'www.courtlistener.com',
    parse: (_url, pathname) => {
      const m = /^\/c\/([^/]+)\/(\d+)\/?$/.exec(pathname);
      if (!m) return null;
      return { reporter_slug: m[1], volume: m[2], source: 'url_parse', host: 'courtlistener.com' };
    }
  },
  {
    name: 'courtlistener_storage_pdf',
    // e.g. https://storage.courtlistener.com/harvard_pdf/2018235.pdf
    // The trailing integer maps to a CL opinion id (NOT cluster id), so we
    // can't cross-ref against gold cl_cluster_id directly.
    hostMatch: (h) => h === 'storage.courtlistener.com',
    parse: (_url, pathname) => {
      const m = /\/([\w-]+)\/(\d+)\.pdf$/i.exec(pathname);
      if (!m) return null;
      return {
        cl_opinion_id: m[2],
        cl_pdf_source: m[1],
        source: 'url_parse',
        host: 'storage.courtlistener.com'
      };
    }
  },
  {
    name: 'justia_case',
    // e.g. /cases/michigan/supreme-court/1971/386-mich-1-2.html
    hostMatch: (h) => h === 'law.justia.com' || h === 'supreme.justia.com',
    parse: (_url, pathname, host) => {
      const m = /^\/cases\/([^/]+)\/([^/]+)\/(\d{4})\/([^/]+)\.html?$/.exec(pathname);
      if (!m) return null;
      // Justia's docket slug often encodes the citation, e.g. "386-mich-1-2"
      // → volume 386, reporter "mich", page 1 (last "-2" is a section).
      const slug = m[4];
      const citeFromSlug = slugToBluebook(slug);
      return {
        state: m[1],
        court_slug: m[2],
        year: m[3],
        docket_slug: slug,
        bluebook_from_url: citeFromSlug,
        source: 'url_parse',
        host
      };
    }
  },
  {
    name: 'justia_supreme_us',
    // e.g. /cases/federal/us/463/1/ or /us/463/1
    hostMatch: (h) => h === 'supreme.justia.com',
    parse: (_url, pathname, host) => {
      const m = /\/(?:us|federal\/us)\/(\d+)\/(\d+)\/?$/.exec(pathname);
      if (!m) return null;
      return {
        bluebook_from_url: `${m[1]} U.S. ${m[2]}`,
        source: 'url_parse',
        host
      };
    }
  },
  {
    name: 'google_scholar_case',
    // e.g. /scholar_case?case=12345678901234567890
    hostMatch: (h) => h === 'scholar.google.com',
    parse: (_url, pathname, host, searchParams) => {
      const caseId = searchParams?.get('case');
      if (!caseId) return null;
      return { google_scholar_case_id: caseId, source: 'url_parse', host };
    }
  },
  {
    name: 'cornell_lii_supreme',
    // e.g. law.cornell.edu/supremecourt/text/463/1 or /supct/html/00-1234.ZO.html
    hostMatch: (h) => h === 'law.cornell.edu' || h === 'www.law.cornell.edu',
    parse: (_url, pathname, host) => {
      let m = /\/supremecourt\/text\/(\d+)\/(\d+)/.exec(pathname);
      if (m) {
        return {
          bluebook_from_url: `${m[1]} U.S. ${m[2]}`,
          source: 'url_parse',
          host
        };
      }
      m = /\/supct\/html\/([\d-]+)\.[A-Z]{2,3}\.html?/.exec(pathname);
      if (m) return { scotus_docket: m[1], source: 'url_parse', host };
      return null;
    }
  },
  {
    name: 'findlaw_caselaw',
    // e.g. caselaw.findlaw.com/{court}/{docket}.html
    hostMatch: (h) => h === 'caselaw.findlaw.com',
    parse: (_url, pathname, host) => {
      const m = /^\/([^/]+)\/([^/]+?)\.html?$/.exec(pathname);
      if (!m) return null;
      return { court_slug: m[1], docket: m[2], source: 'url_parse', host };
    }
  },
  {
    name: 'openjurist',
    // e.g. openjurist.org/463/us/1
    hostMatch: (h) => h === 'openjurist.org' || h === 'www.openjurist.org',
    parse: (_url, pathname, host) => {
      const m = /^\/(\d+)\/([a-z.]+\d*[a-z]*?)\/(\d+)(?:\/|$)/i.exec(pathname);
      if (!m) return null;
      return {
        bluebook_from_url: `${m[1]} ${slugToReporter(m[2])} ${m[3]}`,
        source: 'url_parse',
        host
      };
    }
  },
  // Primary court sites: we can't derive a citation from most of these URLs
  // (they're PDF paths keyed by docket, not by citation). We still note the
  // host so provenance is tracked.
  {
    name: 'primary_court_site',
    // Exact-match or true-subdomain match on the hosts we treat as primary
    // court sites. Bare `endsWith('courts.michigan.gov')` would also match
    // `evilcourts.michigan.gov`, letting a spoofed URL get classified as
    // authoritative (CodeQL: incomplete-url-substring-sanitization).
    hostMatch: (h) =>
      h.endsWith('.uscourts.gov') ||
      h === 'courts.michigan.gov' ||
      h.endsWith('.courts.michigan.gov') ||
      h === 'supremecourt.gov' ||
      h.endsWith('.supremecourt.gov') ||
      h.endsWith('.gov'),
    parse: (_url, _pathname, host) => ({ source: 'url_parse', host, primary_court_site: true })
  }
];

// Convert Justia-style slug "386-mich-1-2" → "386 Mich. 1" (approximate).
export function slugToBluebook(slug) {
  const parts = slug.split('-');
  if (parts.length < 3) return null;
  const volume = parts[0];
  const page = parts[parts.length - (parts.length >= 4 ? 2 : 1)];
  const reporter = parts.slice(1, parts.length - (parts.length >= 4 ? 2 : 1)).join(' ');
  if (!/^\d+$/.test(volume) || !/^\d+$/.test(page)) return null;
  const reporterFmt = slugToReporter(reporter);
  if (!reporterFmt) return null;
  return `${volume} ${reporterFmt} ${page}`;
}

// Convert reporter slugs like "mich", "so2d", "f3d", "n-y" → "Mich.", "So. 2d", "F.3d", "N.Y."
export function slugToReporter(slug) {
  if (!slug) return null;
  const s = slug.replace(/-/g, ' ').trim().toLowerCase();
  // Common series with digit suffixes: f3d → F.3d, so2d → So. 2d
  const seriesMatch = /^([a-z.]+?)(\d[a-z]?d?)$/.exec(s.replace(/\s+/g, ''));
  if (seriesMatch) {
    const base = titleReporter(seriesMatch[1]);
    return `${base}${seriesMatch[2]}`;
  }
  return titleReporter(s);
}

// Reporters where each letter is a capital in Bluebook (per-letter periods).
const LETTER_CAP_REPORTERS = new Set(['us', 'ne', 'nw', 'sw', 'se', 'nj', 'ny']);

function titleReporter(raw) {
  return raw
    .split(/\s+/)
    .map((w) => {
      if (!w) return '';
      const noDots = w.replace(/\./g, '');
      if (!noDots) return '';
      // Single-letter reporters: F., A., S., P.
      if (noDots.length === 1) return `${noDots.toUpperCase()}.`;
      // Per-letter caps: U.S., N.E., N.W., S.W., S.E., N.J., N.Y.
      if (LETTER_CAP_REPORTERS.has(noDots)) {
        return noDots.toUpperCase().split('').join('.') + '.';
      }
      // Default: Title case + trailing period (Mich., Cal., So., Conn.).
      return noDots[0].toUpperCase() + noDots.slice(1) + '.';
    })
    .join(' ')
    .trim();
}

/**
 * Try every URL parser against a URL. Returns the first successful parser's
 * output (with `parser: <name>`), or a minimal `{ host }` record if no
 * parser matched. Never returns null so the caller can log unmatched hosts.
 */
export function parseUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { host: null, unparseable_url: true, source: 'url_parse' }; }
  const host = parsed.host.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname;
  const search = parsed.searchParams;
  for (const p of URL_PARSERS) {
    if (!p.hostMatch(host)) continue;
    const out = p.parse(parsed.href, pathname, host, search);
    if (out) return { ...out, parser: p.name };
  }
  return { host, source: 'url_parse', parser: null, unmatched_host: true };
}

// -----------------------------------------------------------------------
// Text scan for a specific gold citation
// -----------------------------------------------------------------------

const CONTEXT_WINDOW_CHARS = 120;

/**
 * Escape a Bluebook citation for use inside a RegExp. Whitespace in the
 * gold string matches any run of whitespace/punctuation in the excerpt so
 * "13 Mich. 233" matches "13   Mich.  233" and "13 Mich., 233".
 */
export function citationToRegex(citation) {
  const escaped = citation
    .split(/\s+/)
    .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  return new RegExp(escaped, 'gi');
}

/**
 * Classify the context around a citation occurrence as
 * `caption` | `reference` | `unknown`. Reference markers within ~40 chars
 * before the citation take precedence; caption hints (case name, docket
 * number) upgrade `unknown` to `caption`.
 */
export function classifyContext(before, _after) {
  const beforeTrim = before.slice(-40);
  if (REFERENCE_MARKER_RE.test(beforeTrim)) return 'reference';
  if (CAPTION_HINT_BEFORE_RE.test(before)) return 'caption';
  // Empty/short `before` (citation near the start of the excerpt) usually
  // indicates the citation is in a heading/caption.
  if (before.replace(/\s+/g, '').length < 4) return 'caption';
  return 'unknown';
}

/**
 * Find every occurrence of a specific citation string in a text blob.
 * Returns `[{index, contextBefore, contextAfter, contextClass}, ...]`.
 */
export function findCitationInText(text, citation) {
  if (!text || !citation) return [];
  const re = citationToRegex(citation);
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - CONTEXT_WINDOW_CHARS), start);
    const after = text.slice(end, end + CONTEXT_WINDOW_CHARS);
    out.push({
      matched: m[0],
      index: start,
      contextBefore: before,
      contextAfter: after,
      contextClass: classifyContext(before, after)
    });
    if (m.index === re.lastIndex) re.lastIndex += 1; // guard against zero-width
  }
  return out;
}

/**
 * Search a text blob for every citation in `citations` (gold canonical +
 * alternates). Returns the flat list of matches with the citation string
 * that matched attached.
 */
export function findCitationsInText(text, citations) {
  const matches = [];
  for (const citation of citations) {
    if (!citation) continue;
    for (const hit of findCitationInText(text, citation)) {
      matches.push({ ...hit, citation });
    }
  }
  return matches;
}

// -----------------------------------------------------------------------
// Public unified extractor
// -----------------------------------------------------------------------

/**
 * Extract citation evidence from one search result relative to a gold
 * answer. Returns:
 *   {
 *     urlHit: { source: 'url_parse', ... },   // whatever parseUrl returned
 *     urlMatchesGold: bool,                    // e.g. CL cluster_id matches
 *     textMatches: [{ citation, contextClass, contextBefore, contextAfter, ... }],
 *     strongHit: bool,                         // URL cross-ref OR text caption match
 *     looseHit: bool                           // any text match, even reference
 *   }
 *
 * `text` is the union of `title`, `highlights[]`, `text`, `snippet` from
 * the vendor result; caller is responsible for concatenating.
 */
export function extractCitations({ url, text, gold }) {
  const urlHit = url ? parseUrl(url) : null;
  const goldCitations = [
    gold?.canonical_citation,
    ...(gold?.alternates || [])
  ].filter(Boolean);
  const urlMatchesGold = urlHit && gold?.cl_cluster_id && urlHit.cl_cluster_id
    && String(urlHit.cl_cluster_id) === String(gold.cl_cluster_id);
  const textMatches = findCitationsInText(text || '', goldCitations);
  const captionMatch = textMatches.some((m) => m.contextClass === 'caption');
  const strongHit = Boolean(urlMatchesGold) || captionMatch;
  const looseHit = strongHit || textMatches.length > 0;
  return {
    urlHit,
    urlMatchesGold: Boolean(urlMatchesGold),
    textMatches,
    strongHit,
    looseHit,
    contextBreakdown: {
      caption: textMatches.filter((m) => m.contextClass === 'caption').length,
      reference: textMatches.filter((m) => m.contextClass === 'reference').length,
      unknown: textMatches.filter((m) => m.contextClass === 'unknown').length
    }
  };
}

// For tests + adapter internal wiring
export const _internals = {
  REFERENCE_MARKER_RE,
  CAPTION_HINT_BEFORE_RE,
  URL_PARSERS,
  CONTEXT_WINDOW_CHARS
};
