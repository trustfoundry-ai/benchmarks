import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishResultBundle, verifyResultBundle } from '../src/core/artifacts.mjs';
import { sha256File, writeJson, writeJsonl, readJson } from '../src/core/fs.mjs';

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
    run_id: 'raw-asset-test',
    scorer: { id: 'trustfoundry-legal-search' }
  };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  await writeJsonl(path.join(runDir, 'cases.jsonl'), cases);
  await writeJsonl(path.join(runDir, 'provider-results.jsonl'), providerResults);
  return runDir;
}

async function listenOnEphemeralPort(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function findClosedPort() {
  const server = createServer();
  const port = await listenOnEphemeralPort(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('a bundle with no local raw and no href fails loudly, naming the right cause', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'raw-asset-nolocal-nohref-'));
  const bundle = path.join(root, 'bundle');
  await mkdir(bundle, { recursive: true });
  await writeJson(path.join(bundle, 'manifest.json'), {
    schema_version: 'trustfoundry.benchmarks.result-manifest.v1',
    artifacts: {
      raw: { path: 'raw.jsonl.gz', rows: 1, sha256: 'x' },
      result: { path: 'result.json', sha256: 'y' }
    }
  });
  await writeJson(path.join(bundle, 'result.json'), { summary: {} });

  await assert.rejects(
    verifyResultBundle({ repoRoot: root, bundleDir: bundle, allowFetch: false }),
    /neither present locally nor referenced/i
  );
});

test('a bundle with no local raw and a href, fetching disabled, fails loudly, naming the right cause', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'raw-asset-nolocal-href-'));
  const bundle = path.join(root, 'bundle');
  await mkdir(bundle, { recursive: true });
  await writeJson(path.join(bundle, 'manifest.json'), {
    schema_version: 'trustfoundry.benchmarks.result-manifest.v1',
    artifacts: {
      raw: { path: 'raw.jsonl.gz', rows: 1, sha256: 'x', href: 'http://127.0.0.1:1/raw.jsonl.gz' },
      result: { path: 'result.json', sha256: 'y' }
    }
  });
  await writeJson(path.join(bundle, 'result.json'), { summary: {} });

  await assert.rejects(
    verifyResultBundle({ repoRoot: root, bundleDir: bundle, allowFetch: false }),
    /fetching is disabled/i
  );
});

test('a bundle with a local raw copy verifies from it and never touches a remote href', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'raw-asset-local-wins-'));
  const runDir = await makeRun(root);
  const outDir = path.join(root, 'bundle');

  // Nothing is listening on this port -- if verification ever fetched the
  // href instead of using the local copy, this would reject with a
  // connection error rather than passing.
  const deadPort = await findClosedPort();
  await publishResultBundle({
    repoRoot,
    runDir,
    outDir,
    rawHref: `http://127.0.0.1:${deadPort}/raw.jsonl.gz`
  });

  const verification = await verifyResultBundle({ repoRoot, bundleDir: outDir });
  assert.equal(verification.ok, true);
  assert.equal(verification.rows, 1);
});

test('a bundle with no local raw fetches it from the referenced href and verifies', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'raw-asset-fetch-'));
  const runDir = await makeRun(root);
  const publishDir = path.join(root, 'published');
  await publishResultBundle({ repoRoot, runDir, outDir: publishDir });

  // Move the raw evidence out of the bundle directory and serve it over
  // HTTP, the way a release asset would be served.
  const servedPath = path.join(root, 'served-raw.jsonl.gz');
  await rename(path.join(publishDir, 'raw.jsonl.gz'), servedPath);
  const servedBytes = await readFile(servedPath);

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(servedBytes);
  });
  const port = await listenOnEphemeralPort(server);

  try {
    const manifestPath = path.join(publishDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    manifest.artifacts.raw.href = `http://127.0.0.1:${port}/raw.jsonl.gz`;
    await writeJson(manifestPath, manifest);

    const verification = await verifyResultBundle({ repoRoot, bundleDir: publishDir });
    assert.equal(verification.ok, true);
    assert.equal(verification.rows, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a fetched raw copy that does not match the manifest digest fails verification', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'raw-asset-fetch-mismatch-'));
  const runDir = await makeRun(root);
  const publishDir = path.join(root, 'published');
  await publishResultBundle({ repoRoot, runDir, outDir: publishDir });

  const originalRawPath = path.join(publishDir, 'raw.jsonl.gz');
  const originalSha256 = await sha256File(originalRawPath);
  const servedPath = path.join(root, 'served-raw.jsonl.gz');
  await rename(originalRawPath, servedPath);
  const tamperedBytes = Buffer.concat([await readFile(servedPath), Buffer.from('tampered')]);

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(tamperedBytes);
  });
  const port = await listenOnEphemeralPort(server);

  try {
    const manifestPath = path.join(publishDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    // The manifest keeps recording the digest of the original evidence --
    // this is what a served asset that has been altered in transit or at
    // rest looks like.
    assert.equal(manifest.artifacts.raw.sha256, originalSha256);
    manifest.artifacts.raw.href = `http://127.0.0.1:${port}/raw.jsonl.gz`;
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      verifyResultBundle({ repoRoot, bundleDir: publishDir }),
      /digest mismatch/i
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
