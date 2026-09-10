import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assetNameFor, uploadRawAsset } from '../scripts/upload-raw-assets.mjs';
import { readJson, writeJson } from '../src/core/fs.mjs';

async function makeBundle(repoRoot, suite, date, target) {
  const bundleDir = path.join(repoRoot, 'results', suite, date, target);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, 'raw.jsonl.gz'), 'not really gzip, just bytes');
  await writeJson(path.join(bundleDir, 'manifest.json'), {
    schema_version: 'trustfoundry.benchmarks.result-manifest.v1',
    artifacts: {
      raw: { path: 'raw.jsonl.gz', rows: 1, sha256: 'deadbeef' },
      result: { path: 'result.json', sha256: 'cafef00d' }
    }
  });
  return bundleDir;
}

async function withRepoRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'upload-raw-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('assetNameFor flattens the bundle path into a release-unique name', async (t) => {
  const repoRoot = await withRepoRoot(t);
  const bundleDir = path.join(repoRoot, 'results', 'trustfoundry-case-name-lookup', '2026-09-09', 'negatives-50');
  assert.equal(
    assetNameFor(repoRoot, bundleDir),
    'trustfoundry-case-name-lookup__2026-09-09__negatives-50__raw.jsonl.gz'
  );
});

test('uploadRawAsset invokes gh with the exact argv, writes the href, and stages nothing afterward', async (t) => {
  const repoRoot = await withRepoRoot(t);
  const bundleDir = await makeBundle(repoRoot, 'trustfoundry-case-name-lookup', '2026-09-09', 'negatives-50');

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

  assert.equal(
    href,
    'https://github.com/trustfoundry-ai/benchmarks/releases/download/v1.2.3/trustfoundry-case-name-lookup__2026-09-09__negatives-50__raw.jsonl.gz'
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, [
    'release',
    'upload',
    'v1.2.3',
    path.join(bundleDir, 'trustfoundry-case-name-lookup__2026-09-09__negatives-50__raw.jsonl.gz'),
    '--repo',
    'trustfoundry-ai/benchmarks',
    '--clobber'
  ]);

  const manifest = await readJson(path.join(bundleDir, 'manifest.json'));
  assert.equal(manifest.artifacts.raw.href, href);
  // Only the href field changed -- everything else survives untouched.
  assert.equal(manifest.artifacts.raw.sha256, 'deadbeef');
  assert.equal(manifest.artifacts.raw.rows, 1);

  // The staged copy used for the upload must not linger in the bundle
  // directory -- that directory's contents are checksummed.
  const entries = await readdir(bundleDir);
  assert.deepEqual(
    entries.sort(),
    ['manifest.json', 'raw.jsonl.gz'].sort()
  );
});

test('uploadRawAsset removes the staged copy even when the upload fails', async (t) => {
  const repoRoot = await withRepoRoot(t);
  const bundleDir = await makeBundle(repoRoot, 'trustfoundry-case-name-lookup', '2026-09-09', 'negatives-50');

  const exec = async () => {
    throw new Error('gh: network unreachable');
  };

  await assert.rejects(
    uploadRawAsset({ repoRoot, bundleDir, tag: 'v1.2.3', repo: 'trustfoundry-ai/benchmarks', exec }),
    /network unreachable/
  );

  const entries = await readdir(bundleDir);
  assert.deepEqual(entries.sort(), ['manifest.json', 'raw.jsonl.gz'].sort());

  // The manifest is untouched -- a failed upload must not write a href
  // pointing at an asset that was never actually placed on the release.
  const manifest = await readJson(path.join(bundleDir, 'manifest.json'));
  assert.equal(manifest.artifacts.raw.href, undefined);
});

test('uploadRawAsset throws a named error when the bundle has no raw.jsonl.gz', async (t) => {
  const repoRoot = await withRepoRoot(t);
  const bundleDir = path.join(repoRoot, 'results', 'suite', '2026-01-01', 'target');
  await mkdir(bundleDir, { recursive: true });
  await writeJson(path.join(bundleDir, 'manifest.json'), {
    artifacts: { raw: { path: 'raw.jsonl', rows: 1, sha256: 'x' }, result: { path: 'result.json', sha256: 'y' } }
  });
  await writeFile(path.join(bundleDir, 'raw.jsonl'), '{}\n');

  await assert.rejects(
    uploadRawAsset({ repoRoot, bundleDir, tag: 'v1.2.3', repo: 'trustfoundry-ai/benchmarks', exec: async () => {} }),
    /no raw\.jsonl\.gz to upload/
  );
});

test('dry run prints the plan, returns the href, calls no exec, and writes nothing', async (t) => {
  const repoRoot = await withRepoRoot(t);
  const bundleDir = await makeBundle(repoRoot, 'trustfoundry-case-name-lookup', '2026-09-09', 'negatives-50');
  const before = await readJson(path.join(bundleDir, 'manifest.json'));

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

  assert.equal(
    href,
    'https://github.com/trustfoundry-ai/benchmarks/releases/download/v1.2.3/trustfoundry-case-name-lookup__2026-09-09__negatives-50__raw.jsonl.gz'
  );
  assert.equal(execCalled, false);
  assert.ok(logged.some((line) => line.includes('gh release upload v1.2.3')));
  assert.ok(logged.some((line) => line.includes(href)));

  const entries = await readdir(bundleDir);
  assert.deepEqual(entries.sort(), ['manifest.json', 'raw.jsonl.gz'].sort());
  const after = await readJson(path.join(bundleDir, 'manifest.json'));
  assert.deepEqual(after, before);
});
