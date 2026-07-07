export function splitCitationList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitCitationList);
  // Split on `;`, `|`, newline, or `, ` (comma followed by whitespace then a
  // digit — a citation-list separator, not a within-citation comma). Trim
  // whitespace from each element instead of matching it in the split pattern;
  // avoids the polynomial backtracking CodeQL flags on `\s*...\s*` bracketed
  // alternations (js/polynomial-redos).
  return String(value)
    .split(/;|\||\n|,(?=\s+\d)/)
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
