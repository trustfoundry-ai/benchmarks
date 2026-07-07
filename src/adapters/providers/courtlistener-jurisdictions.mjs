import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

const DEFAULT_MAPPING_PATH = 'data/courtlistener/court-jurisdictions.json';
const STATE_APPELLATE_SUPREME = ['S', 'SA'];
const STATE_WITH_SPECIAL = ['S', 'SA', 'SS'];
const STATE_ALL = ['S', 'SA', 'SS', 'ST', 'SAG'];
const FEDERAL_DEFAULT = ['F', 'FD', 'FB', 'FS', 'MA'];
const COURTLISTENER_COURT_ALIASES = {
  ca13: 'cafc'
};
const COURTLISTENER_UI_FEDERAL_COURTS = [
  'scotus', 'ca1', 'ca2', 'ca3', 'ca4', 'ca5', 'ca6', 'ca7', 'ca8', 'ca9',
  'ca10', 'ca11', 'cadc', 'cafc', 'dcd', 'almd', 'alnd', 'alsd', 'akd', 'azd',
  'ared', 'arwd', 'cacd', 'caed', 'cand', 'casd', 'cod', 'ctd', 'ded', 'flmd',
  'flnd', 'flsd', 'gamd', 'gand', 'gasd', 'hid', 'idd', 'ilcd', 'ilnd', 'ilsd',
  'innd', 'insd', 'iand', 'iasd', 'ksd', 'kyed', 'kywd', 'laed', 'lamd', 'lawd',
  'med', 'mdd', 'mad', 'mied', 'miwd', 'mnd', 'msnd', 'mssd', 'moed', 'mowd',
  'mtd', 'ned', 'nvd', 'nhd', 'njd', 'nmd', 'nyed', 'nynd', 'nysd', 'nywd',
  'nced', 'ncmd', 'ncwd', 'ndd', 'ohnd', 'ohsd', 'oked', 'oknd', 'okwd', 'ord',
  'paed', 'pamd', 'pawd', 'rid', 'scd', 'sdd', 'tned', 'tnmd', 'tnwd', 'txed',
  'txnd', 'txsd', 'txwd', 'utd', 'vtd', 'vaed', 'vawd', 'waed', 'wawd', 'wvnd',
  'wvsd', 'wied', 'wiwd', 'wyd', 'gud', 'nmid', 'prd', 'vid', 'californiad',
  'illinoised', 'illinoisd', 'indianad', 'orld', 'ohiod', 'pennsylvaniad',
  'southcarolinaed', 'southcarolinawd', 'tennessed', 'canalzoned', 'bap1',
  'bap2', 'bap6', 'bap8', 'bap9', 'bap10', 'bapme', 'bapma', 'almb', 'alnb',
  'alsb', 'akb', 'arb', 'areb', 'arwb', 'cacb', 'caeb', 'canb', 'casb', 'cob',
  'ctb', 'deb', 'dcb', 'flmb', 'flnb', 'flsb', 'gamb', 'ganb', 'gasb', 'hib',
  'idb', 'ilcb', 'ilnb', 'ilsb', 'innb', 'insb', 'ianb', 'iasb', 'ksb', 'kyeb',
  'kywb', 'laeb', 'lamb', 'lawb', 'meb', 'mdb', 'mab', 'mieb', 'miwb', 'mnb',
  'msnb', 'mssb', 'moeb', 'mowb', 'mtb', 'nebraskab', 'nvb', 'nhb', 'njb',
  'nmb', 'nyeb', 'nynb', 'nysb', 'nywb', 'nceb', 'ncmb', 'ncwb', 'ndb', 'ohnb',
  'ohsb', 'okeb', 'oknb', 'okwb', 'orb', 'paeb', 'pamb', 'pawb', 'rib', 'scb',
  'sdb', 'tneb', 'tnmb', 'tnwb', 'tennesseeb', 'txeb', 'txnb', 'txsb', 'txwb',
  'utb', 'vtb', 'vaeb', 'vawb', 'waeb', 'wawb', 'wvnb', 'wvsb', 'wieb', 'wiwb',
  'wyb', 'gub', 'nmib', 'prb', 'vib'
];

const MODE_DEFAULTS = {
  state_appellate_supreme: {
    stateJurisdictions: STATE_APPELLATE_SUPREME,
    federalJurisdictions: FEDERAL_DEFAULT
  },
  state_appellate_supreme_special: {
    stateJurisdictions: STATE_WITH_SPECIAL,
    federalJurisdictions: FEDERAL_DEFAULT
  },
  state_all: {
    stateJurisdictions: STATE_ALL,
    federalJurisdictions: FEDERAL_DEFAULT
  },
  exact_court: {
    stateJurisdictions: null,
    federalJurisdictions: null
  }
};

const mappingCache = new Map();

function asArray(value, fallback = []) {
  if (value === undefined || value === null) return fallback;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function upper(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toUpperCase()
    : null;
}

function normalizeCourtListenerCourtId(value) {
  const courtId = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!courtId) return null;
  return COURTLISTENER_COURT_ALIASES[courtId] ?? courtId;
}

function resolveMappingPath(config, repoRoot = process.cwd()) {
  const configured =
    config.mapping_path ??
    config.mappingPath ??
    config.jurisdiction_mapping_path ??
    config.jurisdictionMappingPath ??
    DEFAULT_MAPPING_PATH;
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(repoRoot, configured);
}

export function resolveJurisdictionFilterSettings(config = {}) {
  const raw = config.jurisdiction_filter ?? config.jurisdictionFilter ?? null;
  if (raw === null || raw === undefined || raw === false || raw === 'none') {
    return { mode: 'none', enabled: false };
  }

  const filterConfig = typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : { mode: String(raw) };
  const mode = filterConfig.mode ?? 'state_appellate_supreme';
  if (mode === 'none' || filterConfig.enabled === false) {
    return { mode: 'none', enabled: false };
  }

  const defaults = MODE_DEFAULTS[mode];
  if (!defaults && mode !== 'custom') {
    throw new Error(
      `Unknown CourtListener jurisdiction_filter mode '${mode}'. ` +
        `Expected ${Object.keys(MODE_DEFAULTS).join(', ')}, custom, or none.`
    );
  }

  return {
    mode,
    enabled: true,
    mappingPath: resolveMappingPath(filterConfig),
    stateJurisdictions: asArray(
      filterConfig.state_jurisdictions ?? filterConfig.stateJurisdictions,
      defaults?.stateJurisdictions ?? STATE_APPELLATE_SUPREME
    ).map((item) => item.toUpperCase()),
    federalJurisdictions: asArray(
      filterConfig.federal_jurisdictions ?? filterConfig.federalJurisdictions,
      defaults?.federalJurisdictions ?? FEDERAL_DEFAULT
    ).map((item) => item.toUpperCase()),
    federalCourtIds: asArray(
      filterConfig.federal_court_ids ?? filterConfig.federalCourtIds,
      (
        filterConfig.federal_court_set ??
        filterConfig.federalCourtSet
      ) === 'courtlistener_ui'
        ? COURTLISTENER_UI_FEDERAL_COURTS
        : null
    ),
    requireInUse: Boolean(filterConfig.require_in_use ?? filterConfig.requireInUse)
  };
}

export async function loadJurisdictionMap(mappingPath) {
  const resolved = path.isAbsolute(mappingPath)
    ? mappingPath
    : path.resolve(process.cwd(), mappingPath);
  if (!mappingCache.has(resolved)) {
    mappingCache.set(resolved, readJson(resolved));
  }
  return mappingCache.get(resolved);
}

function filterCourts(courts, allowedJurisdictions, { requireInUse = false } = {}) {
  const allowed = new Set(allowedJurisdictions.map((item) => item.toUpperCase()));
  return courts
    .filter((court) => court?.id && allowed.has(upper(court.jurisdiction)))
    .filter((court) => !requireInUse || court.in_use === true)
    .map((court) => court.id)
    .filter(Boolean);
}

function idsForCase(benchmarkCase, mapping, settings) {
  const metadata = benchmarkCase?.metadata ?? {};
  const docType = metadata.doc_type ?? metadata.docType;
  if (docType && docType !== 'case') return [];

  if (settings.mode === 'exact_court') {
    const courtId = normalizeCourtListenerCourtId(metadata.court_id);
    return courtId ? [courtId] : [];
  }

  const state = upper(metadata.state ?? metadata.geo_level_2_identifier);
  if (!state || state === 'FED') {
    if (settings.federalCourtIds?.length) {
      return settings.federalCourtIds;
    }
    return filterCourts(mapping.federal?.courts ?? [], settings.federalJurisdictions, settings);
  }

  return filterCourts(
    mapping.states?.[state]?.courts ?? [],
    settings.stateJurisdictions,
    settings
  );
}

export function buildCourtParam(courtIds) {
  const unique = [...new Set(courtIds)].sort();
  return unique.length ? unique.join(' ') : null;
}

export function buildJurisdictionFilteredQuery(query, benchmarkCase, mapping, settings) {
  if (!settings?.enabled) {
    return {
      query,
      originalQuery: query,
      courtIds: [],
      filterQuery: null,
      courtParam: null,
      applied: false,
      mode: settings?.mode ?? 'none'
    };
  }

  const courtIds = idsForCase(benchmarkCase, mapping, settings);
  const courtParam = buildCourtParam(courtIds);
  return {
    query,
    originalQuery: query,
    courtIds,
    filterQuery: courtParam ? `court=${courtParam}` : null,
    courtParam,
    applied: Boolean(courtParam),
    mode: settings.mode,
    state: upper(benchmarkCase?.metadata?.state ?? benchmarkCase?.metadata?.geo_level_2_identifier)
  };
}

export async function prepareJurisdictionFilteredQuery(query, benchmarkCase, config) {
  const settings = resolveJurisdictionFilterSettings(config);
  if (!settings.enabled) {
    return buildJurisdictionFilteredQuery(query, benchmarkCase, null, settings);
  }
  const mapping = await loadJurisdictionMap(settings.mappingPath);
  return buildJurisdictionFilteredQuery(query, benchmarkCase, mapping, settings);
}

export const _internals = {
  DEFAULT_MAPPING_PATH,
  FEDERAL_DEFAULT,
  COURTLISTENER_UI_FEDERAL_COURTS,
  COURTLISTENER_COURT_ALIASES,
  MODE_DEFAULTS,
  STATE_ALL,
  STATE_APPELLATE_SUPREME,
  STATE_WITH_SPECIAL,
  buildCourtParam,
  idsForCase,
  normalizeCourtListenerCourtId,
  resolveMappingPath
};
