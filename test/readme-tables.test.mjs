import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderReadme, renderSuiteStatusTable } from '../scripts/generate-readme-tables.mjs';

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

test('renderSuiteStatusTable only lists published suites, one row each, with a target count', () => {
  const table = renderSuiteStatusTable([
    { id: 'trustfoundry-a', status: 'published', dir: 'suites/trustfoundry-a', targets: { x: {}, y: {} } },
    { id: 'trustfoundry-b', status: 'experimental', dir: 'suites/trustfoundry-b', targets: { z: {} } }
  ]);
  assert.match(table, /trustfoundry-a/);
  assert.doesNotMatch(table, /trustfoundry-b/);
  assert.match(table, /\| \[`trustfoundry-a`\]\(suites\/trustfoundry-a\/README\.md\) \| published \| 2 \|/);
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
