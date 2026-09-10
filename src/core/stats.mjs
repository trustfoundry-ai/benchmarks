/**
 * Shared statistics for scorers.
 */

// Implements the standard Wilson score interval closed form exactly, with no
// approximation shortcuts -- the Node test suite pins hand-computed
// constants against it so this computation cannot silently drift.
//
// Wilson rather than the normal approximation because per-category rates sit
// close to 1.0 at the row counts a category typically carries, where the
// normal interval overshoots 1.0 and stops being reportable. n === 0 returns
// the full unit interval: a category with no rows is a MISSING measurement,
// not a confident one.
export const Z95 = 1.96;

export function wilsonInterval(successes, n, z = Z95) {
  if (!(n > 0)) return [0, 1];
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
