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
 * Several published targets carry no `summary.headline` block at all (that
 * block is scorer-specific, opt-in extra detail); a missing block renders
 * as an em dash rather than a value computed here or borrowed from an
 * unrelated field. `summary.overallScore` is never read — its cutoff is
 * scorer-specific (legal-search's is hit@25, case-name-lookup's is hit@1)
 * and putting it in one shared column would let a reader compare two
 * different cutoffs without knowing it; every hit-rate cell below instead
 * comes from `summary.overall.hit_at`, one column per cutoff the suite's
 * own bundles report, named by its own key.
 *
 * A target with `headline: false` is not omitted — its scorer may still
 * report something a reader needs, just not a hit rate comparable to the
 * headline rows (an invariant population whose `summary.negatives_overall`
 * is non-empty, e.g.), and its own README-worthy content is surfaced in a
 * dedicated line below the headline table, keyed off the data that target's
 * own bundle carries rather than a hardcoded target id.
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

function mdRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

/**
 * The bundle-count + dated-directory cell for one suite's row in the suite
 * status table. Reads only that suite's `latest.json` pointer — nothing
 * about individual targets — so a suite with no published bundle yet reads
 * as an honest em dash rather than a broken link.
 */
async function publishedBundlesCell({ suite, repoRoot }) {
  const pointerPath = path.join(repoRoot, 'results', suite.id, 'latest.json');
  if (!(await exists(pointerPath))) return '—';
  const pointer = await readJson(pointerPath);
  const relPaths = Object.values(pointer.bundles ?? {});
  if (!relPaths.length) return '—';
  const count = relPaths.length;
  const label = `${count} bundle${count === 1 ? '' : 's'}`;
  const dates = new Set(relPaths.map((rel) => rel.split('/')[0]));
  const dir = dates.size === 1 ? `results/${suite.id}/${[...dates][0]}/` : `results/${suite.id}/`;
  return `${label} under [\`${dir}\`](${dir})`;
}

/**
 * Renders the "Suite status" table: one row per published suite, its
 * declared target count, and how many result bundles it currently has
 * published (with a link to the dated directory when every bundle shares
 * one date, or the suite's whole results directory when they don't).
 */
export async function renderSuiteStatusTable({ suites, repoRoot }) {
  const rows = [];
  for (const suite of suites) {
    if (suite.status !== 'published') continue;
    const targetCount = Object.keys(suite.targets).length;
    const bundlesCell = await publishedBundlesCell({ suite, repoRoot });
    rows.push(
      mdRow([`[\`${suite.id}\`](${suite.dir}/README.md)`, suite.status, String(targetCount), bundlesCell])
    );
  }
  return [mdRow(['Suite', 'Status', 'Targets', 'Published bundles']), '|---|---|---:|---|', ...rows].join(
    '\n'
  );
}

/**
 * Loads the `summary` and `run.scheduler.parallel` for one published
 * target, or `null` if it isn't actually published yet (declared in the
 * manifest but no bundle checked in under the path its own `latest.json`
 * entry names).
 */
async function loadPublishedTarget({ repoRoot, suiteId, targetId, pointer }) {
  const rel = pointer.bundles?.[targetId];
  if (!rel) return null;
  const resultPath = path.join(repoRoot, 'results', suiteId, rel, 'result.json');
  if (!(await exists(resultPath))) return null;
  const doc = await readJson(resultPath);
  return { rel, summary: doc.summary ?? {}, parallel: doc.run?.scheduler?.parallel };
}

/** Ascending sort of `hit@K` keys by their numeric cutoff. */
function sortCutoffs(keys) {
  return [...keys].sort((a, b) => Number(a.slice('hit@'.length)) - Number(b.slice('hit@'.length)));
}

/**
 * Renders the headline table for one suite: one row per `headline: true`
 * target, one column per hit@K cutoff its bundles actually report (derived
 * from the data, since legal-search and case-name-lookup use different
 * cutoff sets), plus the fields every published bundle carries regardless
 * of scorer — MRR, provider failures out of total rows, and latency.
 * `wrong-name rate` only exists on the case-name-lookup scorer; it renders
 * as an em dash for every other suite rather than being a suite-specific
 * column that only sometimes exists.
 */
async function renderHeadlineTable({ suite, repoRoot, pointer }) {
  const headlineTargets = Object.entries(suite.targets).filter(([, target]) => target.headline === true);

  const entries = [];
  for (const [targetId, target] of headlineTargets) {
    const loaded = await loadPublishedTarget({ repoRoot, suiteId: suite.id, targetId, pointer });
    if (!loaded) continue;
    entries.push({ targetId, target, ...loaded });
  }
  if (!entries.length) return null;

  const cutoffs = sortCutoffs(
    new Set(entries.flatMap(({ summary }) => Object.keys(summary.overall?.hit_at ?? {})))
  );

  // A latency figure with no stated concurrency can't be compared to
  // anything. When every headline row ran at the same `--parallel` value,
  // say so once beneath the table (reads better, and is correct when it
  // applies). Otherwise — including when a bundle's own
  // `run.scheduler.parallel` is simply missing — concurrency becomes a
  // per-row column instead of being silently dropped; disclosure never
  // falls back to nothing.
  const isUniformParallel =
    entries.every(({ parallel }) => typeof parallel === 'number') &&
    new Set(entries.map(({ parallel }) => parallel)).size === 1;

  const header = mdRow([
    'Target',
    'Rows',
    ...cutoffs,
    'hit@1 95% CI',
    'MRR',
    'wrong-name rate',
    'provider failures',
    ...(isUniformParallel ? [] : ['parallel']),
    'p50',
    'p95'
  ]);
  const align = mdRow([
    '---',
    '---:',
    ...cutoffs.map(() => '---:'),
    '---',
    '---:',
    '---:',
    '---:',
    ...(isUniformParallel ? [] : ['---:']),
    '---:',
    '---:'
  ]);

  const rows = entries.map(({ targetId, target, rel, summary, parallel }) => {
    const hitAt = summary.overall?.hit_at ?? {};
    const ci = summary.headline?.ci95;
    const ciText = Array.isArray(ci) ? `[${formatScore(ci[0])}, ${formatScore(ci[1])}]` : '—';
    return mdRow([
      `[\`${targetId}\`](results/${suite.id}/${rel}/)`,
      String(target.rows),
      ...cutoffs.map((cutoff) => formatScore(hitAt[cutoff])),
      ciText,
      formatScore(summary.overall?.mrr),
      formatScore(summary.wrong_name?.rate),
      `${summary.providerFailures ?? '—'}/${summary.total ?? '—'}`,
      ...(isUniformParallel ? [] : [typeof parallel === 'number' ? String(parallel) : '—']),
      formatMs(summary.latency_ms?.p50),
      formatMs(summary.latency_ms?.p95)
    ]);
  });

  const concurrencyLine = isUniformParallel
    ? `\n\nLatency measured at \`--parallel ${entries[0].parallel}\`.`
    : '';

  return `${[header, align, ...rows].join('\n')}${concurrencyLine}`;
}

/**
 * Renders one line per target whose published bundle reports a non-empty
 * `summary.negatives_overall` (an invariant/negative population — rows with
 * no correct answer to hit, so a hit rate would misreport it as failure).
 * Membership is decided by that field being present with `n > 0` on the
 * bundle itself, not by a hardcoded target id, so a second suite that ships
 * its own negatives population is picked up the same way.
 */
async function renderNegativePopulations({ suite, repoRoot, pointer }) {
  const lines = [];
  for (const targetId of Object.keys(suite.targets)) {
    const loaded = await loadPublishedTarget({ repoRoot, suiteId: suite.id, targetId, pointer });
    if (!loaded) continue;
    const negatives = loaded.summary.negatives_overall;
    if (!negatives || !(negatives.n > 0)) continue;
    const link = `results/${suite.id}/${loaded.rel}/`;
    lines.push(
      `- **Invariant population** [\`${targetId}\`](${link}): false-positive rate ` +
        `${formatScore(negatives.fp_rate)} (lower is better) — ${negatives.correct_empty}/${negatives.n} ` +
        'correctly returned no match.'
    );
  }
  return lines;
}

/**
 * Lists smoke-tier targets (cheap, non-headline companions to a headline
 * run) as links, so a reader who wants the cheap version can still find it
 * even though it isn't a row in the headline table.
 */
async function renderSmokeCompanions({ suite, repoRoot, pointer }) {
  const links = [];
  for (const [targetId, target] of Object.entries(suite.targets)) {
    if (target.tier !== 'smoke') continue;
    const loaded = await loadPublishedTarget({ repoRoot, suiteId: suite.id, targetId, pointer });
    if (!loaded) continue;
    links.push(`[\`${targetId}\`](results/${suite.id}/${loaded.rel}/)`);
  }
  if (!links.length) return [];
  return [`- Smoke-tier companions (cheap, non-headline): ${links.join(', ')}.`];
}

export async function renderResultsTables({ suites, repoRoot }) {
  const sections = [];
  for (const suite of suites) {
    if (suite.status !== 'published') continue;

    const pointerPath = path.join(repoRoot, 'results', suite.id, 'latest.json');
    if (!(await exists(pointerPath))) continue;
    const pointer = await readJson(pointerPath);

    const table = await renderHeadlineTable({ suite, repoRoot, pointer });
    if (!table) continue;

    const noteLines = [
      ...(await renderNegativePopulations({ suite, repoRoot, pointer })),
      ...(await renderSmokeCompanions({ suite, repoRoot, pointer }))
    ];
    const notes = noteLines.length ? `\n\n${noteLines.join('\n')}` : '';

    sections.push(
      `#### ${suite.title}\n\n${table}${notes}\n\n` +
        `See [\`${suite.dir}/README.md\`](${suite.dir}/README.md) for the per-category and per-axis breakdown.`
    );
  }
  return sections.join('\n\n');
}

export async function renderReadme({ repoRoot, readme }) {
  const suites = await listSuites({ repoRoot });
  let out = replaceRegion(readme, 'suite-status', await renderSuiteStatusTable({ suites, repoRoot }));
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
