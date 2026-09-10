#!/usr/bin/env node
/**
 * The suite-status and latest-benchmarks tables in README.md are derived
 * from the suite registry (`suites/<id>/suite.json`) and each published
 * suite's `results/<suite>/latest.json` pointer, so they cannot drift from
 * what the repository actually declares and publishes. A test
 * (`test/readme-tables.test.mjs`) asserts the committed README matches what
 * this generator produces; `--check` gives the same assertion as a CLI exit
 * code for CI.
 *
 * Per `src/core/contracts/suite-manifest.schema.json`, "published suites
 * appear in the generated README tables; experimental and deprecated do
 * not" — both render functions below filter on `status === 'published'`.
 *
 * A suite's targets may include more than one `headline: true` target (one
 * per independent category), so the results table renders every headline
 * target as its own row rather than reducing a suite to a single row.
 * Several published targets carry no `summary.headline` block at all
 * (that block is scorer-specific, opt-in extra detail); a missing block
 * renders as an em dash rather than a value computed here or borrowed from
 * an unrelated field.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exists, readJson } from '../src/core/fs.mjs';
import { listSuites } from '../src/core/suites.mjs';

const MARKER_NAMES = ['suite-status', 'latest-benchmarks'];

function beginMarker(name) {
  return `<!-- BEGIN GENERATED: ${name} -->`;
}

function endMarker(name) {
  return `<!-- END GENERATED: ${name} -->`;
}

/**
 * Replaces everything between a named pair of marker comments with `body`,
 * leaving the rest of `text` untouched byte-for-byte. Refuses to guess when
 * the markers are missing, duplicated, or out of order — a generator that
 * silently no-ops or truncates the file on a malformed marker is worse than
 * one that errors.
 */
function replaceRegion(text, name, body) {
  const begin = beginMarker(name);
  const end = endMarker(name);

  const beginIndex = text.indexOf(begin);
  if (beginIndex === -1) {
    throw new Error(`README is missing the '${begin}' marker`);
  }
  if (text.indexOf(begin, beginIndex + 1) !== -1) {
    throw new Error(`README has more than one '${begin}' marker`);
  }

  const endIndex = text.indexOf(end);
  if (endIndex === -1) {
    throw new Error(`README is missing the '${end}' marker`);
  }
  if (text.indexOf(end, endIndex + 1) !== -1) {
    throw new Error(`README has more than one '${end}' marker`);
  }

  if (endIndex < beginIndex) {
    throw new Error(`README has '${end}' before '${begin}' — markers are out of order`);
  }

  const before = text.slice(0, beginIndex);
  const after = text.slice(endIndex + end.length);
  return `${before}${begin}\n${body}\n${end}${after}`;
}

function formatScore(value) {
  return typeof value === 'number' ? value.toFixed(4) : '—';
}

function formatMs(value) {
  return typeof value === 'number' ? `${Math.round(value)} ms` : '—';
}

/**
 * Renders the "Suite status" table. Only `suite.id`, `suite.status`, and
 * `suite.targets` are used — no filesystem access beyond what `listSuites`
 * already did — so this stays a pure function of the registry.
 */
export function renderSuiteStatusTable(suites) {
  const rows = suites
    .filter((suite) => suite.status === 'published')
    .map((suite) => {
      const targetCount = Object.keys(suite.targets).length;
      return `| [\`${suite.id}\`](${suite.dir}/README.md) | ${suite.status} | ${targetCount} |`;
    });
  return ['| Suite | Status | Targets |', '|---|---|---:|', ...rows].join('\n');
}

/**
 * Renders one markdown table per published suite, one row per
 * `headline: true` target, sourced from that suite's `latest.json` pointer
 * and the pointed-at `result.json`'s `summary`. A suite with several
 * headline targets (legal-search has four) gets one row per target, never
 * a single reduced row. `summary.overallScore` is never used here — its
 * cutoff is scorer-specific (legal-search reports hit@25 there, case-name
 * hit@1) and putting it in one shared column would let a reader compare
 * two different cutoffs without knowing it. The hit-rate column is always
 * `summary.overall.hit_at['hit@1']`, named explicitly in its own header.
 */
export async function renderResultsTables({ suites, repoRoot }) {
  const sections = [];
  for (const suite of suites) {
    if (suite.status !== 'published') continue;

    const pointerPath = path.join(repoRoot, 'results', suite.id, 'latest.json');
    if (!(await exists(pointerPath))) continue;
    const pointer = await readJson(pointerPath);

    const headlineTargets = Object.entries(suite.targets).filter(
      ([, target]) => target.headline === true
    );

    const rows = [];
    for (const [targetId, target] of headlineTargets) {
      const rel = pointer.bundles?.[targetId];
      if (!rel) continue;
      const resultPath = path.join(repoRoot, 'results', suite.id, rel, 'result.json');
      if (!(await exists(resultPath))) continue;

      const summary = (await readJson(resultPath)).summary ?? {};
      const hit1 = summary.overall?.hit_at?.['hit@1'];
      const mrr = summary.overall?.mrr;
      const ci = summary.headline?.ci95;
      const latency = summary.latency_ms ?? {};

      const ciText = Array.isArray(ci) ? `[${formatScore(ci[0])}, ${formatScore(ci[1])}]` : '—';
      rows.push(
        `| [\`${targetId}\`](results/${suite.id}/${rel}/) | ${target.rows} | ${formatScore(hit1)} | ` +
          `${ciText} | ${formatScore(mrr)} | ${formatMs(latency.p50)} | ${formatMs(latency.p95)} |`
      );
    }
    if (!rows.length) continue;

    const table = [
      '| Target | Rows | hit@1 | hit@1 95% CI | MRR | p50 | p95 |',
      '|---|---:|---:|---|---:|---:|---:|',
      ...rows
    ].join('\n');
    sections.push(
      `#### ${suite.title}\n\n${table}\n\n` +
        `See [\`${suite.dir}/README.md\`](${suite.dir}/README.md) for the per-category and per-axis breakdown.`
    );
  }
  return sections.join('\n\n');
}

export async function renderReadme({ repoRoot, readme }) {
  const suites = await listSuites({ repoRoot });
  let out = replaceRegion(readme, 'suite-status', renderSuiteStatusTable(suites));
  out = replaceRegion(out, 'latest-benchmarks', await renderResultsTables({ suites, repoRoot }));
  return out;
}

/**
 * Finds the smallest region of two texts that actually differs — the
 * longest common prefix and suffix, by line — so a `--check` failure can
 * show a reader what differs instead of just asserting that it does.
 */
function describeDiff(current, expected) {
  const a = current.split('\n');
  const b = expected.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) {
    aEnd -= 1;
    bEnd -= 1;
  }
  const removed = a.slice(start, aEnd + 1);
  const added = b.slice(start, bEnd + 1);
  const lines = [`README differs from the generator starting at line ${start + 1}:`];
  for (const line of removed) lines.push(`- ${line}`);
  for (const line of added) lines.push(`+ ${line}`);
  return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(repoRoot, 'README.md');
  const current = await readFile(file, 'utf8');
  const next = await renderReadme({ repoRoot, readme: current });

  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error(describeDiff(current, next));
      console.error(
        "\nREADME generated regions are stale — run `node scripts/generate-readme-tables.mjs`"
      );
      process.exit(1);
    }
    console.log('README generated regions are current');
  } else {
    await writeFile(file, next);
    console.log('README generated regions updated');
  }
}

// Exported for tests that want to exercise marker-handling edge cases
// directly without round-tripping through a file.
export const __internal = { replaceRegion, describeDiff, MARKER_NAMES };
