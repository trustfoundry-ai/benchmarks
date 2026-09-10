// Decides whether two benchmark runs may legitimately be compared to each
// other. Two runs are comparable only when the benchmark config, every
// dataset source file's digest, and the scorer config and version all
// agree — anything else means the runs measured different things, and a
// difference in one of the numbers wouldn't tell you why.
//
// A missing value on either side is treated as a difference, not as
// agreement: `undefined !== undefined` is `false`, so a naive equality
// check would call two bundles that both lack a field "comparable" on the
// strength of evidence it never had. Declining to bless a pair this
// function can't fully check is the correct failure direction.

function isMissing(value) {
  return value === undefined || value === null;
}

export function compareInputs(a, b) {
  const differences = [];

  const push = (field, x, y) => {
    if (isMissing(x) || isMissing(y)) {
      differences.push({ field, a: x ?? null, b: y ?? null });
      return;
    }
    if (x !== y) differences.push({ field, a: x, b: y });
  };

  push('benchmark.configSha256', a?.benchmark?.configSha256, b?.benchmark?.configSha256);
  push('scorer.configSha256', a?.scorer?.configSha256, b?.scorer?.configSha256);
  push('scorer.version', a?.scorer?.version, b?.scorer?.version);

  const digests = (m) =>
    new Map((m?.benchmark?.sourceFiles ?? []).map((f) => [f.path, f.sha256]));
  const da = digests(a);
  const db = digests(b);
  for (const key of new Set([...da.keys(), ...db.keys()])) {
    push(`dataset:${key}`, da.get(key), db.get(key));
  }

  return { comparable: differences.length === 0, differences };
}
