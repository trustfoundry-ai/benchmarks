#!/usr/bin/env node
/**
 * Fixed-row regression tripwire for the smoke tier.
 *
 * Comparing a run against the same rows from a committed baseline cancels
 * subsampling error entirely -- it is the identical set of pairs on both
 * sides. The only noise left is the provider, measured at zero across two
 * independent runs of the full target, so one changed row out of 525
 * (0.19pp) is signal. That is what makes this an exact per-row comparison
 * rather than a tolerance band on an aggregate. The default allowance of 5
 * changed rows (0.95pp) keeps a legitimate corpus or index update from being
 * brittle; it never hides a change, which is always reported regardless of
 * the allowance.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJson, writeJson } from '../src/core/fs.mjs';

const USAGE = 'usage: check-smoke-baseline.mjs --run <dir> [--allow N] [--write]';

// The summary line counts unchanged rows from the baseline side only:
// `total` is the number of baseline rows, so subtracting the full `changed`
// count from it would fold in `unexpected` rows (rows the run has that the
// baseline never did) and understate how many baseline rows actually held.
// `unexpected` rows get their own figure instead of being mixed into that
// subtraction.
export function formatSummaryLine({ total, changed, allowedChanges }) {
  const baselineChanged = changed.filter((row) => row.kind !== 'unexpected').length;
  const unexpected = changed.filter((row) => row.kind === 'unexpected').length;
  const baselineUnchanged = total - baselineChanged;
  return (
    `smoke baseline: ${baselineUnchanged}/${total} baseline rows unchanged, ` +
    `${baselineChanged} changed, ${unexpected} unexpected (allowance ${allowedChanges})`
  );
}

// Drives the per-row display off `kind` rather than inferring it from
// `was`/`now`, which for `missing`/`unexpected` rows hold display prose, not
// a comparable pair. Only a `flipped` row can carry a rank change, and a rank
// move with the hit verdict unchanged (e.g. `true -> true`) is otherwise
// indistinguishable at a glance from no change at all -- the rank detail is
// appended whenever the ranks differ, regardless of whether the hit did too.
export function formatChangedRow(row) {
  const verdict = `${row.caseId}  ${row.category}/${row.arm}  ${row.was} -> ${row.now}`;
  if (row.kind !== 'flipped' || row.wasRank === row.nowRank) return `  ${verdict}`;
  return `  ${verdict}  (rank ${row.wasRank} -> ${row.nowRank})`;
}

function rowFrom(row) {
  return {
    hit: Boolean(row.hitAt1),
    rank: row.hitRank ?? null,
    category: row.nameTransform ?? null,
    arm: row.arm ?? null
  };
}

export function compareToBaseline({ baseline, scores, allowedChanges = 5 }) {
  const current = new Map();
  for (const row of scores.caseScores ?? []) {
    current.set(row.caseId, rowFrom(row));
  }

  const changed = [];
  for (const [caseId, was] of Object.entries(baseline.rows)) {
    const now = current.get(caseId);
    if (!now) {
      changed.push({
        caseId,
        category: was.category,
        arm: was.arm,
        kind: 'missing',
        was: was.hit,
        now: 'missing from run'
      });
      continue;
    }
    if (now.hit !== was.hit || now.rank !== was.rank) {
      changed.push({
        caseId,
        category: was.category,
        arm: was.arm,
        kind: 'flipped',
        was: was.hit,
        now: now.hit,
        wasRank: was.rank,
        nowRank: now.rank
      });
    }
  }
  for (const [caseId, now] of current.entries()) {
    if (!(caseId in baseline.rows)) {
      changed.push({
        caseId,
        category: now.category,
        arm: now.arm,
        kind: 'unexpected',
        was: 'absent from baseline',
        now: now.hit
      });
    }
  }

  // allowedChanges is compared against changed.length as a whole -- flipped,
  // missing, and unexpected rows all count against it. An unexpected row
  // means the run and the baseline disagree about which rows exist at all,
  // which is exactly the kind of drift this gate exists to catch, so it is
  // not exempted from the allowance just because it has no baseline verdict
  // to compare against.
  return { ok: changed.length <= allowedChanges, changed, total: Object.keys(baseline.rows).length };
}

export function baselineFrom({ target, scores }) {
  const rows = {};
  for (const row of scores.caseScores ?? []) {
    rows[row.caseId] = rowFrom(row);
  }
  return { target, rows };
}

// Parses argv left to right so a flag's value is always the token that
// immediately follows it, never located by a whole-argv scan. That is what
// makes a malformed invocation -- a flag-shaped token where a value belongs,
// a flag with no value, a repeated flag -- fail loudly instead of silently
// misreading which token means what.
export function parseArgs(argv) {
  const valueFlags = new Set(['--run', '--allow']);
  let runDir;
  let allowRaw;
  let write = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--run') {
        if (runDir !== undefined) throw new Error('--run given more than once');
        runDir = value;
      } else {
        if (allowRaw !== undefined) throw new Error('--allow given more than once');
        allowRaw = value;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }

  if (runDir === undefined) throw new Error('missing required --run <dir>');

  let allowedChanges = 5;
  if (allowRaw !== undefined) {
    const n = Number(allowRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('--allow requires a non-negative integer');
    }
    allowedChanges = n;
  }

  return { runDir, allowedChanges, write };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }

  const { runDir, allowedChanges, write } = parsed;
  const baselinePath = path.join(
    process.cwd(),
    'results',
    'trustfoundry-case-name-lookup',
    'smoke-baseline.json'
  );
  const scores = await readJson(path.join(runDir, 'scores.json'));

  if (write) {
    const baseline = baselineFrom({ target: 'trustfoundry-case-name-lookup/public-1050', scores });
    await writeJson(baselinePath, baseline);
    console.log(`wrote baseline: ${(scores.caseScores ?? []).length} rows`);
    process.exit(0);
  }

  const baseline = await readJson(baselinePath);
  const { ok, changed, total } = compareToBaseline({ baseline, scores, allowedChanges });
  console.log(formatSummaryLine({ total, changed, allowedChanges }));
  for (const row of changed) {
    console.log(formatChangedRow(row));
  }
  if (!ok) {
    console.error(
      `\n${changed.length} changed rows exceeds the allowance of ${allowedChanges}.\n` +
        'If the corpus or index legitimately moved, re-baseline with --write and record why in the commit.'
    );
    process.exit(1);
  }
}
