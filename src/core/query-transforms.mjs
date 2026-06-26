export const STRIP_SYNTHETIC_INSTRUCTION_PREFIXES =
  'strip-synthetic-instruction-prefixes-v1';

const NONE_IDS = new Set(['', 'none', 'raw', 'identity']);

const SAFE_COLON_PREFIX_RE = /^(?:"?\s*)?(?:plain[- ]language(?:\s+(?:for\s+non[- ]lawyers(?:\s+on\s+impact)?|takeaway|on\s+impact))?|in\s+plain\s+language\s+for\s+non[- ]lawyers|expert(?:\s+\([^)]*\)|\s+(?:with|without)\s+citations?|\s+with\s+citation\s+analyzing\s+precedent|\s+without\s+citation\s+on\s+application)?|as\s+an\s+expert(?:\s+(?:with|without)\s+citations?)?|from\s+an\s+expert(?:[- ]without[- ]citation\s+on\s+application|\s+perspective\s+with\s+citation)?|with\s+citations?|without\s+citation|question\s+\d+\s+\((?:with|without)\s+citation\))\s*$/i;

const LEADING_PREFIX_RULES = [
  {
    id: 'as_expert_with_without_citation',
    re: /^(?:as\s+an\s+)?expert\s+(?:with|without)\s+citations?(?:\s+on\s+application)?,\s*/i
  },
  {
    id: 'as_expert_with_without_citation_analyzing_precedent',
    re: /^(?:as\s+an\s+)?expert\s+(?:with|without)\s+citations?\s+analyzing\s+precedent,\s*/i
  },
  {
    id: 'in_plain_language',
    re: /^in\s+plain(?:[-\s]+language|\s+terms)(?:\s+for\s+non[- ]lawyers)?,\s*/i
  },
  {
    id: 'plain_language_for_non_lawyers',
    re: /^plain[- ]language\s+for\s+non[- ]lawyers,?\s*/i
  },
  {
    id: 'explain_plain_terms',
    re: /^explain\s+in\s+plain\s+terms\s+/i
  },
  {
    id: 'explain_without_citing',
    re: /^explain,\s+without\s+citing\s+(?:cases|authorities),\s*/i
  }
];

function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function stripBalancedOuterQuotes(text) {
  let value = text.trim();
  const removed = [];
  for (;;) {
    const trimmed = value.trim();
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (
      trimmed.length >= 2 &&
      ((first === '"' && last === '"') || (first === "'" && last === "'"))
    ) {
      removed.push(first);
      value = trimmed.slice(1, -1).trim();
    } else {
      return { text: value, removed };
    }
  }
}

function stripColonInstructionPrefix(text) {
  const colonIndex = text.indexOf(':');
  if (colonIndex < 0 || colonIndex > 90) return { text, removedPrefix: null };
  const prefix = text.slice(0, colonIndex).trim();
  if (!SAFE_COLON_PREFIX_RE.test(prefix)) return { text, removedPrefix: null };
  return {
    text: text.slice(colonIndex + 1).trim(),
    removedPrefix: `${prefix}:`
  };
}

function stripLeadingInstructionPhrases(text) {
  let current = text;
  const applied = [];
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const rule of LEADING_PREFIX_RULES) {
      const match = rule.re.exec(current);
      if (!match?.[0]) continue;
      current = current.slice(match[0].length).trim();
      applied.push({ rule: rule.id, removed: match[0].trim() });
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return { text: current, applied };
}

export function stripSyntheticInstructionPrefixes(query) {
  const rawQuery = String(query ?? '');
  let current = normalizeWhitespace(rawQuery);
  const rulesApplied = [];
  const removedPrefixes = [];

  const outer = stripBalancedOuterQuotes(current);
  if (outer.removed.length) {
    current = outer.text;
    rulesApplied.push('strip_outer_quotes');
  }

  const colon = stripColonInstructionPrefix(current);
  if (colon.removedPrefix) {
    current = colon.text;
    rulesApplied.push('strip_colon_instruction_prefix');
    removedPrefixes.push(colon.removedPrefix);
  }

  const leading = stripLeadingInstructionPhrases(current);
  if (leading.applied.length) {
    current = leading.text;
    for (const item of leading.applied) {
      rulesApplied.push(item.rule);
      removedPrefixes.push(item.removed);
    }
  }

  current = normalizeWhitespace(current);
  return {
    id: STRIP_SYNTHETIC_INSTRUCTION_PREFIXES,
    rawQuery,
    searchQuery: current,
    transformed: current !== normalizeWhitespace(rawQuery),
    rulesApplied,
    removedPrefixes
  };
}

export function applyQueryTransform(query, transformId = null) {
  const id = String(transformId ?? '').trim();
  if (!id || NONE_IDS.has(id)) {
    const rawQuery = String(query ?? '');
    return {
      id: id || null,
      rawQuery,
      searchQuery: rawQuery,
      transformed: false,
      rulesApplied: [],
      removedPrefixes: []
    };
  }
  if (id === STRIP_SYNTHETIC_INSTRUCTION_PREFIXES) {
    return stripSyntheticInstructionPrefixes(query);
  }
  throw new Error(`Unknown query transform: ${id}`);
}
