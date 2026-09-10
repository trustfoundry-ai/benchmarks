import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
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

  // A separate, genuinely valid bundle's raw evidence -- decompressible and
  // schema-correct, just not the bytes this bundle's manifest describes.
  // Serving something well-formed (rather than garbage) means the only way
  // this test can fail is the assertion that actually matters: whether the
  // server was asked for anything at all. Garbage content would make a
  // fetch-then-use bug crash loudly on its own, which would prove nothing
  // about whether the local copy is preferred.
  const altRunDir = await makeRun(await mkdtemp(path.join(tmpdir(), 'raw-asset-local-wins-alt-')));
  const altOutDir = path.join(root, 'alt-bundle');
  await publishResultBundle({ repoRoot, runDir: altRunDir, outDir: altOutDir });
  const alternateValidBytes = await readFile(path.join(altOutDir, 'raw.jsonl.gz'));

  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(alternateValidBytes);
  });
  const port = await listenOnEphemeralPort(server);

  try {
    await publishResultBundle({
      repoRoot,
      runDir,
      outDir,
      rawHref: `http://127.0.0.1:${port}/raw.jsonl.gz`
    });

    const verification = await verifyResultBundle({ repoRoot, bundleDir: outDir });
    assert.equal(verification.ok, true);
    assert.equal(verification.rows, 1);
    assert.equal(requestCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

test('a connection that dies mid-fetch does not leave a temp directory behind', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'raw-asset-leak-'));
  const runDir = await makeRun(root);
  const publishDir = path.join(root, 'published');
  await publishResultBundle({ repoRoot, runDir, outDir: publishDir });
  // No local copy -- verification is forced onto the fetch path.
  await rm(path.join(publishDir, 'raw.jsonl.gz'));

  const server = createServer((_req, res) => {
    // Promise a body far larger than what is actually sent, flush headers
    // so the fetch settles with a readable response, write a few bytes,
    // then sever the connection on the next tick -- the body stream fails
    // *after* resolveRawPath has already created its temp directory, which
    // is the failure mode that leaked one.
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': '999999' });
    res.flushHeaders();
    res.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));
    setTimeout(() => res.socket.destroy(), 20);
  });
  const port = await listenOnEphemeralPort(server);

  try {
    const manifestPath = path.join(publishDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    manifest.artifacts.raw.href = `http://127.0.0.1:${port}/raw.jsonl.gz`;
    await writeJson(manifestPath, manifest);

    const before = new Set(await readdir(tmpdir()));

    await assert.rejects(verifyResultBundle({ repoRoot, bundleDir: publishDir }));

    // The assertion is about the filesystem, not the rejection: a leak
    // means an orphaned `raw-asset-*` directory survives the failed call.
    const after = await readdir(tmpdir());
    const leaked = after.filter((entry) => entry.startsWith('raw-asset-') && !before.has(entry));
    assert.deepEqual(leaked, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
