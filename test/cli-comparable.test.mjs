import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareInputs } from '../src/core/comparable.mjs';
import { main } from '../src/cli.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const base = {
  benchmark: { configSha256: 'a', sourceFiles: [{ path: 'd.jsonl', sha256: 'd1' }] },
  scorer: { configSha256: 's', version: 'v1' }
};

test('identical inputs are comparable', () => {
  assert.equal(compareInputs(base, structuredClone(base)).comparable, true);
});

test('a differing dataset digest is reported', () => {
  const other = structuredClone(base);
  other.benchmark.sourceFiles[0].sha256 = 'd2';
  const res = compareInputs(base, other);
  assert.equal(res.comparable, false);
  assert.ok(res.differences.some((d) => d.field === 'dataset:d.jsonl'));
});

test('a differing scorer version is reported', () => {
  const other = structuredClone(base);
  other.scorer.version = 'v2';
  assert.ok(compareInputs(base, other).differences.some((d) => d.field === 'scorer.version'));
});

test('a field both inputs omit is reported as a difference, not agreement', () => {
  const left = structuredClone(base);
  const right = structuredClone(base);
  delete left.scorer.version;
  delete right.scorer.version;
  const res = compareInputs(left, right);
  assert.equal(res.comparable, false);
  const diff = res.differences.find((d) => d.field === 'scorer.version');
  assert.ok(diff, 'expected scorer.version to be named as a difference');
  assert.equal(diff.a, null);
  assert.equal(diff.b, null);
});

// ---- comparableCommand, driven through main() directly ----
//
// main() never calls process.exit itself (bin/benchmarks.mjs's real entry
// point is the only thing that does, in its .catch()), so it's safe to call
// in-process: capture console.log/console.error, replicate the entry
// point's own catch-and-report behavior, and always restore both console
// methods and process.exitCode afterward so a failure here can't leak into
// tests that run later in the same process.
async function runCli(args) {
  const stdoutLines = [];
  const stderrLines = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.log = (...parts) => stdoutLines.push(parts.join(' '));
  console.error = (...parts) => stderrLines.push(parts.join(' '));
  process.exitCode = undefined;
  try {
    await main(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  const result = {
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
    exitCode: process.exitCode ?? 0
  };
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode;
  return result;
}

const REGS_200 = path.join(repoRoot, 'results/trustfoundry-legal-search/2026-07-05/regs-200');
const LAWS_200 = path.join(repoRoot, 'results/trustfoundry-legal-search/2026-07-05/laws-200');

test('comparable on two identical published bundles exits 0 and confirms on stdout', async () => {
  const { stdout, stderr, exitCode } = await runCli(['comparable', REGS_200, REGS_200]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /comparable:.*share benchmark, dataset and scorer inputs/);
  assert.equal(stderr, '');
});

test('comparable on two genuinely different published bundles exits non-zero and names each field on stderr', async () => {
  const { stdout, stderr, exitCode } = await runCli(['comparable', REGS_200, LAWS_200]);
  assert.notEqual(exitCode, 0);
  assert.equal(stdout, '');
  assert.match(stderr, /^NOT comparable:/);
  assert.match(stderr, /benchmark\.configSha256/);
  assert.match(stderr, /dataset:data\/trustfoundry-legal-search\/regs\.jsonl/);
  assert.match(stderr, /dataset:data\/trustfoundry-legal-search\/laws\.jsonl/);
});

test('comparable with a missing second argument reports the documented error instead of crashing', async () => {
  const { stderr, exitCode } = await runCli(['comparable', REGS_200]);
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /comparable requires two run directories or bundles/);
});

test('comparable is reachable through main\'s dispatch and printHelp names its real argument shape', async () => {
  const { stdout } = await runCli(['help']);
  assert.match(stdout, /comparable <a> <b>/);
});

// ---- the loader's manifest.json branch ----
//
// comparableCommand's loader reads manifest.json directly when it carries a
// `benchmark` key, and only falls through to result.json's `run` when it
// doesn't (the shape a published bundle's own manifest.json has). Every
// invocation above compares two published bundles, so only the fall-through
// has ever run. These fixtures give each temp directory both a manifest.json
// carrying a `benchmark` key AND a result.json with deliberately different
// digests, so a regression that fell through anyway would read visibly
// wrong values instead of coincidentally matching ones.

async function makeRunDir(t, { benchmarkSha, datasetPath, datasetSha, scorerSha, scorerVersion }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'comparable-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      benchmark: { configSha256: benchmarkSha, sourceFiles: [{ path: datasetPath, sha256: datasetSha }] },
      scorer: { configSha256: scorerSha, version: scorerVersion }
    })
  );
  // If comparableCommand ever fell through to this despite manifest.json
  // carrying a `benchmark` key, every field below would read as "WRONG"
  // instead of the manifest's real values — a silent fall-through cannot
  // pass these tests by accident.
  await writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify({
      run: {
        benchmark: { configSha256: 'WRONG', sourceFiles: [{ path: datasetPath, sha256: 'WRONG' }] },
        scorer: { configSha256: 'WRONG', version: 'WRONG' }
      }
    })
  );
  return dir;
}

test('comparableCommand reads manifest.json directly when it carries a benchmark key, not falling through to result.json', async (t) => {
  const shared = {
    benchmarkSha: 'run-benchmark-sha',
    datasetPath: 'data/fixture.jsonl',
    datasetSha: 'run-dataset-sha',
    scorerSha: 'run-scorer-sha',
    scorerVersion: 'run-scorer-v1'
  };
  const dirA = await makeRunDir(t, shared);
  const dirB = await makeRunDir(t, shared);
  const { stdout, stderr, exitCode } = await runCli(['comparable', dirA, dirB]);
  // Both manifests are identical, so a correct read reports comparable.
  // A regression that ignored manifest.json and fell through to
  // result.json would compare two 'WRONG' runs that are equal to each
  // other too, so this test alone would not catch that regression --
  // the mixed test below closes that gap by pairing a run directory
  // against a published bundle whose true digests are known and differ.
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /comparable:/);
});

test('comparable between a synthetic run directory and a published bundle exercises both loader branches', async (t) => {
  // regs-200's real result.json run.benchmark.configSha256 is
  // 3de0e445c5a1533ed8eb38f58e56a3252f783c5bdfcf0f3a489ed60fe30e52e4 (read
  // via the fall-through branch, since its manifest.json is a bundle
  // manifest with no `benchmark` key). This fixture's manifest.json
  // deliberately uses different digests throughout, so the mismatch can
  // only be detected if the run directory's manifest.json branch fired
  // (reading its real values, not 'WRONG') and the bundle's fall-through
  // branch fired (reading regs-200's real, differing values).
  const dir = await makeRunDir(t, {
    benchmarkSha: 'synthetic-benchmark-sha',
    datasetPath: 'data/synthetic-fixture.jsonl',
    datasetSha: 'synthetic-dataset-sha',
    scorerSha: 'synthetic-scorer-sha',
    scorerVersion: 'synthetic-scorer-v1'
  });
  const { stdout, stderr, exitCode } = await runCli(['comparable', dir, REGS_200]);
  assert.notEqual(exitCode, 0);
  assert.equal(stdout, '');
  assert.match(stderr, /^NOT comparable:/);
  assert.match(stderr, /benchmark\.configSha256/);
  assert.match(stderr, /a: synthetic-benchmark-sha/);
  assert.match(stderr, /b: 3de0e445c5a1533ed8eb38f58e56a3252f783c5bdfcf0f3a489ed60fe30e52e4/);
  assert.match(stderr, /dataset:data\/synthetic-fixture\.jsonl/);
  assert.match(stderr, /dataset:data\/trustfoundry-legal-search\/regs\.jsonl/);
});
