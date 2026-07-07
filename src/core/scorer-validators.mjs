// Reusable helpers for scorer authors implementing `validateConfig`.
// Kept separate from runner.mjs and registry.mjs so scorer adapters can
// import from here without introducing a cycle (registry -> scorer ->
// runner -> registry).

function sameIntegerSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sortA = [...a].map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  const sortB = [...b].map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (sortA.length !== sortB.length) return false;
  return sortA.every((value, idx) => value === sortB[idx]);
}

// Rejects a scorer config whose cutoffs / headline_cutoff diverge from
// the scorer's implementation-side constants. Scorers whose result-bundle
// schema pins hits@K to a fixed set of K values should call this from
// their `validateConfig` method so misconfiguration errors surface at
// startup, not after a full run finishes.
export function validateScorerCutoffsMatchImplementation(
  scorerConfig = {},
  { supportedCutoffs, supportedHeadlineCutoff, scorerId } = {}
) {
  const configuredCutoffs = scorerConfig.cutoffs;
  const configuredHeadline =
    scorerConfig.headline_cutoff ?? scorerConfig.headlineCutoff;

  if (
    configuredCutoffs !== undefined &&
    supportedCutoffs !== undefined &&
    !sameIntegerSet(configuredCutoffs, supportedCutoffs)
  ) {
    throw new Error(
      `Scorer config invalid: cutoffs ${JSON.stringify(configuredCutoffs)} ` +
        `differs from the scorer's implementation ${JSON.stringify(supportedCutoffs)}. ` +
        `The result-bundle schema currently pins hits@K to these specific K values; ` +
        `update both src/adapters/scorers/${scorerId ?? 'the scorer'}.mjs and the ` +
        `artifact schema together to change them.`
    );
  }
  if (
    configuredHeadline !== undefined &&
    supportedHeadlineCutoff !== undefined &&
    Number.parseInt(String(configuredHeadline), 10) !== supportedHeadlineCutoff
  ) {
    throw new Error(
      `Scorer config invalid: headline_cutoff ${configuredHeadline} ` +
        `differs from the scorer's implementation ${supportedHeadlineCutoff}.`
    );
  }
}
