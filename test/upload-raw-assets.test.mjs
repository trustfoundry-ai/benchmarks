import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assetNameFor, hrefFor, parseArgs, uploadRawAsset } from '../scripts/upload-raw-assets.mjs';
import { publishResultBundle } from '../src/core/artifacts.mjs';
import { readJson, sha256File, writeJson, writeJsonl } from '../src/core/fs.mjs';

async function makeRun(root) {
  const runDir = path.join(root, 'run');
  const cases = [
    {
      caseId: 'case-1',
      benchmarkId: 'trustfoundry-legal-search',
      split: 'test',
      prompt: 'query',
      metadata: {
        datasetIndex: 0,
        datasetName: 'case_questions',
        doc_type: 'case',
        field: 'questions',
        model_type: 'case_question',
        state: 'MI',
        document_uuid: '11111111-1111-1111-1111-111111111111',
        expected: { canonical_citation: '1 Test 1', alternates: [] }
      }
    }
  ];
  const providerResults = [
    {
      caseId: 'case-1',
      status: 'completed',
      rawOutput: {
        request: { query: 'query', model_type: 'case_question', state: 'MI' },
        httpStatus: 200,
        normalizedResults: [
          { rank: 1, document_uuid: '11111111-1111-1111-1111-111111111111' }
        ]
      },
      finalOutputText: JSON.stringify({
        result_count: 1,
        total_available: 1,
        results: [
          { rank: 1, document_uuid: '11111111-1111-1111-1111-111111111111' }
        ]
      }),
      providerMetadata: { httpStatus: 200, totalAvailable: 1 },
      timing: { durationMs: 10, serverResponseDurationMs: 8 }
    }
  ];
  const manifest = {
    run_id: 'upload-raw-assets-test',
    scorer: { id: 'trustfoundry-legal-search' }
  };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  await writeJsonl(path.join(runDir, 'cases.jsonl'), cases);
  await writeJsonl(path.join(runDir, 'provider-results.jsonl'), providerResults);
  return runDir;
}

// Publishes a real bundle (raw.jsonl.gz, result.json, manifest.json,
// checksums.txt, all with real digests) via the same code path a genuine
// publish uses, so tests exercise uploadRawAsset against fixtures that are
// not hand-assembled approximations of the real shape.
async function makeBundle(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'upload-raw-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = await makeRun(root);
  const bundleDir = path.join(root, 'results', 'trustfoundry-legal-search', '2026-09-09', 'negatives-50');
  await publishResultBundle({ repoRoot: root, runDir, outDir: bundleDir });
  return { repoRoot: root, bundleDir };
}

test('assetNameFor flattens the bundle path into a release-unique name', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'upload-raw-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDir = path.join(root, 'results', 'trustfoundry-case-name-lookup', '2026-09-09', 'negatives-50');
  assert.equal(
    assetNameFor(root, bundleDir),
    'trustfoundry-case-name-lookup__2026-09-09__negatives-50__raw.jsonl.gz'
  );
});

test('hrefFor is computable from repo, tag, and bundle path alone, and matches what uploadRawAsset writes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'upload-raw-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDir = path.join(root, 'results', 'trustfoundry-case-name-lookup', '2026-09-09', 'negatives-50');
  assert.equal(
    hrefFor({ repo: 'trustfoundry-ai/benchmarks', tag: 'v1.2.3', repoRoot: root, bundleDir }),
    'https://github.com/trustfoundry-ai/benchmarks/releases/download/v1.2.3/trustfoundry-case-name-lookup__2026-09-09__negatives-50__raw.jsonl.gz'
  );
});

test('uploadRawAsset invokes gh with the exact argv, writes the href, and stages nothing afterward', async (t) => {
  const { repoRoot, bundleDir } = await makeBundle(t);

  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
  };

  const href = await uploadRawAsset({
    repoRoot,
    bundleDir,
    tag: 'v1.2.3',
    repo: 'trustfoundry-ai/benchmarks',
    exec
  });

  const expectedAssetName =
    'trustfoundry-legal-search__2026-09-09__negatives-50__raw.jsonl.gz';
  assert.equal(
    href,
    `https://github.com/trustfoundry-ai/benchmarks/releases/download/v1.2.3/${expectedAssetName}`
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, [
    'release',
    'upload',
    'v1.2.3',
    path.join(bundleDir, expectedAssetName),
    '--repo',
    'trustfoundry-ai/benchmarks',
    '--clobber'
  ]);

  const manifest = await readJson(path.join(bundleDir, 'manifest.json'));
  assert.equal(manifest.artifacts.raw.href, href);
  // Only the href field changed -- the digest and row count survive untouched.
  const rawSha256 = await sha256File(path.join(bundleDir, 'raw.jsonl.gz'));
  assert.equal(manifest.artifacts.raw.sha256, rawSha256);

  // The staged copy used for the upload must not linger in the bundle
  // directory -- that directory's contents are checksummed.
  const entries = await readdir(bundleDir);
  assert.deepEqual(
    entries.sort(),
    ['checksums.txt', 'manifest.json', 'raw.jsonl.gz', 'result.json'].sort()
  );
});

test('uploadRawAsset regenerates checksums.txt so the manifest.json line matches the rewritten file, and leaves the other lines untouched', async (t) => {
  const { repoRoot, bundleDir } = await makeBundle(t);

  const beforeChecksums = await readFile(path.join(bundleDir, 'checksums.txt'), 'utf8');
  const beforeLines = beforeChecksums.trim().split('\n');
  const rawLineBefore = beforeLines.find((line) => line.endsWith('raw.jsonl.gz'));
  const resultLineBefore = beforeLines.find((line) => line.endsWith('result.json'));

  await uploadRawAsset({
    repoRoot,
    bundleDir,
    tag: 'v1.2.3',
    repo: 'trustfoundry-ai/benchmarks',
    exec: async () => {}
  });

  const afterChecksums = await readFile(path.join(bundleDir, 'checksums.txt'), 'utf8');
  const afterLines = afterChecksums.trim().split('\n');
  const rawLineAfter = afterLines.find((line) => line.endsWith('raw.jsonl.gz'));
  const resultLineAfter = afterLines.find((line) => line.endsWith('result.json'));
  const manifestLineAfter = afterLines.find((line) => line.endsWith('manifest.json'));

  // raw.jsonl.gz and result.json were never touched by the href rewrite --
  // their checksums.txt lines must be byte-identical to before.
  assert.equal(rawLineAfter, rawLineBefore);
  assert.equal(resultLineAfter, resultLineBefore);

  // manifest.json's line must match its actual, current digest -- this is
  // the whole point: a stale line here fails `shasum -c` for a reader with
  // no way to distinguish that from real tampering.
  const manifestSha256 = await sha256File(path.join(bundleDir, 'manifest.json'));
  assert.equal(manifestLineAfter, `${manifestSha256}  manifest.json`);

  // Format matches publishResultBundle's own checksums.txt exactly: three
  // lines, "<sha256>  <name>", trailing newline, same order.
  assert.equal(afterLines.length, 3);
  assert.ok(afterChecksums.endsWith('\n'));
});

test('uploadRawAsset removes the staged copy even when the upload fails, and leaves the manifest and checksums untouched', async (t) => {
  const { repoRoot, bundleDir } = await makeBundle(t);
  const manifestBefore = await readFile(path.join(bundleDir, 'manifest.json'), 'utf8');
  const checksumsBefore = await readFile(path.join(bundleDir, 'checksums.txt'), 'utf8');

  const exec = async () => {
    throw new Error('gh: network unreachable');
  };

  await assert.rejects(
    uploadRawAsset({ repoRoot, bundleDir, tag: 'v1.2.3', repo: 'trustfoundry-ai/benchmarks', exec }),
    /network unreachable/
  );

  const entries = await readdir(bundleDir);
  assert.deepEqual(
    entries.sort(),
    ['checksums.txt', 'manifest.json', 'raw.jsonl.gz', 'result.json'].sort()
  );

  // A failed upload must not write a href pointing at an asset that was
  // never actually placed on the release, and must not touch checksums.txt.
  const manifestAfter = await readFile(path.join(bundleDir, 'manifest.json'), 'utf8');
  const checksumsAfter = await readFile(path.join(bundleDir, 'checksums.txt'), 'utf8');
  assert.equal(manifestAfter, manifestBefore);
  assert.equal(checksumsAfter, checksumsBefore);
});

test('uploadRawAsset throws a named error when the bundle has no raw.jsonl.gz', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'upload-raw-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDir = path.join(root, 'results', 'suite', '2026-01-01', 'target');
  await mkdir(bundleDir, { recursive: true });
  await writeJson(path.join(bundleDir, 'manifest.json'), {
    artifacts: { raw: { path: 'raw.jsonl', rows: 1, sha256: 'x' }, result: { path: 'result.json', sha256: 'y' } }
  });
  await writeFile(path.join(bundleDir, 'raw.jsonl'), '{}\n');

  await assert.rejects(
    uploadRawAsset({ repoRoot: root, bundleDir, tag: 'v1.2.3', repo: 'trustfoundry-ai/benchmarks', exec: async () => {} }),
    /no raw\.jsonl\.gz to upload/
  );
});

test('dry run prints the plan, returns the href, calls no exec, and writes nothing', async (t) => {
  const { repoRoot, bundleDir } = await makeBundle(t);
  const before = await readJson(path.join(bundleDir, 'manifest.json'));
  const checksumsBefore = await readFile(path.join(bundleDir, 'checksums.txt'), 'utf8');

  let execCalled = false;
  const exec = async () => {
    execCalled = true;
  };

  const originalLog = console.log;
  const logged = [];
  console.log = (line) => logged.push(line);
  let href;
  try {
    href = await uploadRawAsset({
      repoRoot,
      bundleDir,
      tag: 'v1.2.3',
      repo: 'trustfoundry-ai/benchmarks',
      dryRun: true,
      exec
    });
  } finally {
    console.log = originalLog;
  }

  const expectedAssetName =
    'trustfoundry-legal-search__2026-09-09__negatives-50__raw.jsonl.gz';
  assert.equal(
    href,
    `https://github.com/trustfoundry-ai/benchmarks/releases/download/v1.2.3/${expectedAssetName}`
  );
  assert.equal(execCalled, false);
  assert.ok(logged.some((line) => line.includes('gh release upload v1.2.3')));
  assert.ok(logged.some((line) => line.includes(href)));

  const entries = await readdir(bundleDir);
  assert.deepEqual(
    entries.sort(),
    ['checksums.txt', 'manifest.json', 'raw.jsonl.gz', 'result.json'].sort()
  );
  const after = await readJson(path.join(bundleDir, 'manifest.json'));
  assert.deepEqual(after, before);
  const checksumsAfter = await readFile(path.join(bundleDir, 'checksums.txt'), 'utf8');
  assert.equal(checksumsAfter, checksumsBefore);
});

test('parseArgs accepts the happy path with an explicit --repo', () => {
  assert.deepEqual(
    parseArgs(['--tag', 'v1.2.3', '--repo', 'someone/else', 'results/a', 'results/b']),
    { tag: 'v1.2.3', repo: 'someone/else', dryRun: false, bundles: ['results/a', 'results/b'] }
  );
});

test('parseArgs defaults --repo and accepts --dry-run at the start, middle, and end', () => {
  const expected = { tag: 'v1.2.3', repo: 'trustfoundry-ai/benchmarks', dryRun: true, bundles: ['results/a'] };
  assert.deepEqual(parseArgs(['--dry-run', '--tag', 'v1.2.3', 'results/a']), expected);
  assert.deepEqual(parseArgs(['--tag', 'v1.2.3', '--dry-run', 'results/a']), expected);
  assert.deepEqual(parseArgs(['--tag', 'v1.2.3', 'results/a', '--dry-run']), expected);
});

test('parseArgs rejects a flag-shaped token where --tag expects a value', () => {
  assert.throws(
    () => parseArgs(['--tag', '--dry-run', 'v1.2.3', 'results/a']),
    /--tag requires a value/
  );
});

test('parseArgs rejects --tag with no value at end of argv', () => {
  assert.throws(() => parseArgs(['results/a', '--tag']), /--tag requires a value/);
});

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--tag', 'v1.2.3', '--bundle', 'results/a']), /unknown flag: --bundle/);
});

test('parseArgs rejects a repeated --tag rather than silently keeping the first', () => {
  assert.throws(
    () => parseArgs(['--tag', 'v1.0.0', '--tag', 'v2.0.0', 'results/a']),
    /--tag given more than once/
  );
});

test('parseArgs rejects a repeated --repo rather than silently keeping the first', () => {
  assert.throws(
    () => parseArgs(['--tag', 'v1.0.0', '--repo', 'a/b', '--repo', 'c/d', 'results/a']),
    /--repo given more than once/
  );
});

test('parseArgs treats a bundle path beginning with a single dash as positional, not a flag', () => {
  assert.deepEqual(
    parseArgs(['--tag', 'v1.2.3', '-weird-bundle-name']),
    { tag: 'v1.2.3', repo: 'trustfoundry-ai/benchmarks', dryRun: false, bundles: ['-weird-bundle-name'] }
  );
});

test('parseArgs rejects a missing --tag', () => {
  assert.throws(() => parseArgs(['results/a']), /missing required --tag/);
});

test('parseArgs rejects an empty bundle list', () => {
  assert.throws(() => parseArgs(['--tag', 'v1.2.3']), /at least one bundle directory is required/);
});
