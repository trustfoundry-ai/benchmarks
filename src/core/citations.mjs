export function splitCitationList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitCitationList);
  return String(value)
    .split(/\s*(?:;|\||,\s+(?=\d)|\n)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeCitation(value) {
  if (!value) return null;
  return String(value)
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

export function acceptedCitationSet(expected) {
  const values = [
    expected?.canonical_citation,
    expected?.canonicalCitation,
    expected?.citation,
    expected?.alternates,
    expected?.alternate_citations
  ];
  return new Set(
    values
      .flatMap(splitCitationList)
      .map(normalizeCitation)
      .filter(Boolean)
  );
}
