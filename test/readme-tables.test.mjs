import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderReadme, renderResultsTables, renderSuiteStatusTable } from '../scripts/generate-readme-tables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the committed README matches the generator', async () => {
  const current = await readFile(path.join(root, 'README.md'), 'utf8');
  const expected = await renderReadme({ repoRoot: root, readme: current });
  assert.equal(
    current,
    expected,
    'README generated regions are stale — run `node scripts/generate-readme-tables.mjs`'
  );
});

test('renderSuiteStatusTable only lists published suites, one row each, with a target count and bundle cell', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'suite-status-test-'));
  try {
    const suites = [
      { id: 'trustfoundry-a', status: 'published', dir: 'suites/trustfoundry-a', targets: { x: {}, y: {} } },
      { id: 'trustfoundry-b', status: 'experimental', dir: 'suites/trustfoundry-b', targets: { z: {} } }
    ];
    // No results/ directory in this fixture repoRoot at all, so the
    // "Published bundles" cell for trustfoundry-a must read as an honest
    // em dash rather than throwing or fabricating a count.
    const table = await renderSuiteStatusTable({ suites, repoRoot: dir });
    assert.match(table, /trustfoundry-a/);
    assert.doesNotMatch(table, /trustfoundry-b/);
    assert.match(
      table,
      /\| \[`trustfoundry-a`\]\(suites\/trustfoundry-a\/README\.md\) \| published \| 2 \| — \|/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderSuiteStatusTable reports a published bundle count and its dated directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'suite-status-test-'));
  try {
    await mkdir(path.join(dir, 'results', 'trustfoundry-a'), { recursive: true });
    await writeFile(
      path.join(dir, 'results', 'trustfoundry-a', 'latest.json'),
      JSON.stringify({ bundles: { x: '2026-01-01/x', y: '2026-01-01/y' } }),
      'utf8'
    );
    const suites = [
      { id: 'trustfoundry-a', status: 'published', dir: 'suites/trustfoundry-a', targets: { x: {}, y: {} } }
    ];
    const table = await renderSuiteStatusTable({ suites, repoRoot: dir });
    assert.match(table, /2 bundles under \[`results\/trustfoundry-a\/2026-01-01\/`\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderResultsTables derives cutoff columns from the data, surfaces the invariant population and smoke companions separately, and states concurrency once when uniform', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'results-tables-test-'));
  try {
    const suite = {
      id: 'trustfoundry-demo',
      title: 'Demo Suite',
      status: 'published',
      dir: 'suites/trustfoundry-demo',
      targets: {
        'full-100': { rows: 100, tier: 'full', headline: true },
        'smoke-20': { rows: 20, tier: 'smoke' },
        'negatives-10': { rows: 10, tier: 'full' }
      }
    };

    const resultsDir = path.join(dir, 'results', suite.id);
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, 'latest.json'),
      JSON.stringify({
        bundles: {
          'full-100': '2026-01-01/full-100',
          'smoke-20': '2026-01-01/smoke-20',
          'negatives-10': '2026-01-01/negatives-10'
        }
      }),
      'utf8'
    );

    async function writeBundle(targetId, result) {
      const bundleDir = path.join(resultsDir, '2026-01-01', targetId);
      await mkdir(bundleDir, { recursive: true });
      await writeFile(path.join(bundleDir, 'result.json'), JSON.stringify(result), 'utf8');
    }

    await writeBundle('full-100', {
      run: { scheduler: { parallel: 4 } },
      summary: {
        overall: { hit_at: { 'hit@1': 0.9, 'hit@5': 0.95 }, mrr: 0.92 },
        providerFailures: 0,
        total: 100,
        latency_ms: { p50: 100, p95: 200 }
        // No `wrong_name`, no `headline` block — this scorer never reports them.
      }
    });
    await writeBundle('smoke-20', {
      run: { scheduler: { parallel: 4 } },
      summary: { overall: { hit_at: { 'hit@1': 0.9 }, mrr: 0.9 }, providerFailures: 0, total: 20 }
    });
    await writeBundle('negatives-10', {
      run: { scheduler: { parallel: 4 } },
      summary: {
        overall: { hit_at: { 'hit@1': 0 }, mrr: 0 },
        providerFailures: 0,
        total: 10,
        negatives_overall: { n: 10, correct_empty: 9, fp_rate: 0.1 }
      }
    });

    const output = await renderResultsTables({ suites: [suite], repoRoot: dir });

    assert.match(output, /\| Target \| Rows \| hit@1 \| hit@5 \|/, 'cutoff columns come from the data');
    assert.match(output, /\[`full-100`\].*\| 0\.9000 \| 0\.9500 \|/, 'hit@1 and hit@5 both render for full-100');
    assert.doesNotMatch(
      output,
      /\| \[`negatives-10`\]/,
      'the invariant population is not a row in the headline table'
    );
    assert.match(
      output,
      /Invariant population.*\[`negatives-10`\].*false-positive rate 0\.1000 \(lower is better\).*9\/10/,
      'the invariant population gets its own line with a stated direction'
    );
    assert.match(
      output,
      /Smoke-tier companions.*\[`smoke-20`\]/,
      'the smoke-tier companion is linked even though it is not a headline row'
    );
    assert.match(output, /Latency measured at `--parallel 4`\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Builds a two-headline-target suite fixture under a fresh temp repoRoot,
 * one bundle per given `parallel` value, and returns the rendered
 * `renderResultsTables` output. Used by the two tests below to prove both
 * directions of the uniform-vs-per-row concurrency branch: neither can rot
 * without a fixture actually exercising it.
 */
async function renderConcurrencyFixture(parallels) {
  const dir = await mkdtemp(path.join(tmpdir(), 'concurrency-test-'));
  try {
    const suite = {
      id: 'trustfoundry-concurrency',
      title: 'Concurrency Suite',
      status: 'published',
      dir: 'suites/trustfoundry-concurrency',
      targets: Object.fromEntries(
        parallels.map((_, i) => [`target-${i}`, { rows: 10, tier: 'full', headline: true }])
      )
    };

    const resultsDir = path.join(dir, 'results', suite.id);
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, 'latest.json'),
      JSON.stringify({
        bundles: Object.fromEntries(parallels.map((_, i) => [`target-${i}`, `2026-01-01/target-${i}`]))
      }),
      'utf8'
    );

    for (const [i, parallel] of parallels.entries()) {
      const bundleDir = path.join(resultsDir, '2026-01-01', `target-${i}`);
      await mkdir(bundleDir, { recursive: true });
      const run = typeof parallel === 'number' ? { scheduler: { parallel } } : {};
      await writeFile(
        path.join(bundleDir, 'result.json'),
        JSON.stringify({
          run,
          summary: {
            overall: { hit_at: { 'hit@1': 0.5 }, mrr: 0.5 },
            providerFailures: 0,
            total: 10,
            latency_ms: { p50: 100 + i, p95: 200 + i }
          }
        }),
        'utf8'
      );
    }

    return await renderResultsTables({ suites: [suite], repoRoot: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('renderResultsTables states concurrency once when every headline row shares one --parallel value', async () => {
  const output = await renderConcurrencyFixture([4, 4]);
  assert.match(output, /Latency measured at `--parallel 4`\./);
  assert.doesNotMatch(output, /\| parallel \|/, 'no per-row parallel column when the value is uniform');
});

test('renderResultsTables renders a per-row parallel column when concurrency differs, never dropping disclosure', async () => {
  const output = await renderConcurrencyFixture([4, 8]);
  assert.doesNotMatch(output, /Latency measured at/, 'no single blanket line when rows disagree');
  assert.match(output, /\| provider failures \| parallel \| p50 \| p95 \|/, 'a parallel column is added');
  assert.match(output, /\[`target-0`\].*\| 4 \| 100 ms \| 200 ms \|/);
  assert.match(output, /\[`target-1`\].*\| 8 \| 101 ms \| 201 ms \|/);
});

test('renderResultsTables treats a missing run.scheduler.parallel as non-uniform and renders it as an em dash, not a dropped disclosure', async () => {
  const output = await renderConcurrencyFixture([4, undefined]);
  assert.doesNotMatch(output, /Latency measured at/, 'a missing value must not be silently treated as uniform');
  assert.match(output, /\| provider failures \| parallel \| p50 \| p95 \|/);
  assert.match(output, /\[`target-0`\].*\| 4 \| 100 ms \| 200 ms \|/);
  assert.match(output, /\[`target-1`\].*\| — \| 101 ms \| 201 ms \|/);
});

async function withTempReadme(body, run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'readme-tables-test-'));
  try {
    const file = path.join(dir, 'README.md');
    await writeFile(file, body, 'utf8');
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('renderReadme throws when the suite-status begin marker is missing', async () => {
  await withTempReadme(
    '# Doc\n\n<!-- END GENERATED: suite-status -->\n\n<!-- BEGIN GENERATED: latest-benchmarks -->\n<!-- END GENERATED: latest-benchmarks -->\n',
    async (file) => {
      const readme = await readFile(file, 'utf8');
      await assert.rejects(
        () => renderReadme({ repoRoot: root, readme }),
        /missing the '<!-- BEGIN GENERATED: suite-status -->' marker/
      );
    }
  );
});

test('renderReadme throws when a marker is duplicated', async () => {
  const body = [
    '# Doc',
    '',
    '<!-- BEGIN GENERATED: suite-status -->',
    '<!-- END GENERATED: suite-status -->',
    '',
    '<!-- BEGIN GENERATED: suite-status -->',
    '<!-- END GENERATED: suite-status -->',
    '',
    '<!-- BEGIN GENERATED: latest-benchmarks -->',
    '<!-- END GENERATED: latest-benchmarks -->',
    ''
  ].join('\n');
  await withTempReadme(body, async (file) => {
    const readme = await readFile(file, 'utf8');
    await assert.rejects(
      () => renderReadme({ repoRoot: root, readme }),
      /more than one '<!-- BEGIN GENERATED: suite-status -->' marker/
    );
  });
});

test('renderReadme throws when the end marker precedes the begin marker', async () => {
  const body = [
    '# Doc',
    '',
    '<!-- END GENERATED: suite-status -->',
    '<!-- BEGIN GENERATED: suite-status -->',
    '',
    '<!-- BEGIN GENERATED: latest-benchmarks -->',
    '<!-- END GENERATED: latest-benchmarks -->',
    ''
  ].join('\n');
  await withTempReadme(body, async (file) => {
    const readme = await readFile(file, 'utf8');
    await assert.rejects(
      () => renderReadme({ repoRoot: root, readme }),
      /'<!-- END GENERATED: suite-status -->' before '<!-- BEGIN GENERATED: suite-status -->'/
    );
  });
});

test('renderReadme leaves everything outside the marked regions untouched', async () => {
  const before = '# Doc\n\nSome prose above.\n\n';
  const after = '\n\nSome prose below.\n';
  const body =
    `${before}<!-- BEGIN GENERATED: suite-status -->\nstale\n<!-- END GENERATED: suite-status -->` +
    `\n\n<!-- BEGIN GENERATED: latest-benchmarks -->\nstale\n<!-- END GENERATED: latest-benchmarks -->${after}`;
  const rendered = await renderReadme({ repoRoot: root, readme: body });
  assert.ok(rendered.startsWith(before), 'text before the first marker must be untouched');
  assert.ok(rendered.endsWith(after), 'text after the last marker must be untouched');
});
