import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  clearCheckpoints,
  loadCaseCheckpoints,
  writeCaseCheckpoint,
  writeCaseProgressCheckpoint
} from '../src/core/checkpoints.mjs';
import { readJson } from '../src/core/fs.mjs';

async function withTempDir(runner) {
  const dir = await mkdtemp(path.join(tmpdir(), 'checkpoints-test-'));
  try {
    await runner(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writeCaseCheckpoint + loadCaseCheckpoints round-trip', async () => {
  await withTempDir(async (dir) => {
    const manifestFingerprint = 'fp-1';
    const benchmarkCase = { caseId: 'c-1', benchmarkId: 'b', prompt: 'q' };
    const providerResult = { caseId: 'c-1', status: 'completed' };
    await writeCaseCheckpoint({
      outputRoot: dir,
      manifestFingerprint,
      benchmarkCase,
      providerResult
    });
    const loaded = await loadCaseCheckpoints({
      outputRoot: dir,
      manifestFingerprint
    });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].case.caseId, 'c-1');
    assert.equal(loaded[0].providerResult.status, 'completed');
    assert.equal(loaded[0].manifestFingerprint, manifestFingerprint);
  });
});

test('loadCaseCheckpoints throws on fingerprint mismatch', async () => {
  await withTempDir(async (dir) => {
    await writeCaseCheckpoint({
      outputRoot: dir,
      manifestFingerprint: 'fp-a',
      benchmarkCase: { caseId: 'c-1' },
      providerResult: { caseId: 'c-1', status: 'completed' }
    });
    await assert.rejects(
      loadCaseCheckpoints({ outputRoot: dir, manifestFingerprint: 'fp-b' }),
      /Checkpoint fingerprint mismatch/
    );
  });
});

test('writeCaseCheckpoint safely handles caseIds with slashes', async () => {
  await withTempDir(async (dir) => {
    await writeCaseCheckpoint({
      outputRoot: dir,
      manifestFingerprint: 'fp-x',
      benchmarkCase: { caseId: 'suite/nested:case-1' },
      providerResult: { caseId: 'suite/nested:case-1', status: 'completed' }
    });
    const loaded = await loadCaseCheckpoints({
      outputRoot: dir,
      manifestFingerprint: 'fp-x'
    });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].case.caseId, 'suite/nested:case-1');
  });
});

test('clearCheckpoints removes the checkpoint tree', async () => {
  await withTempDir(async (dir) => {
    await writeCaseCheckpoint({
      outputRoot: dir,
      manifestFingerprint: 'fp',
      benchmarkCase: { caseId: 'c-1' },
      providerResult: { caseId: 'c-1', status: 'completed' }
    });
    await clearCheckpoints({ outputRoot: dir });
    const loaded = await loadCaseCheckpoints({ outputRoot: dir, manifestFingerprint: 'fp' });
    assert.equal(loaded.length, 0);
  });
});

test('writeCaseProgressCheckpoint emits a progress summary', async () => {
  await withTempDir(async (dir) => {
    const manifest = {
      runId: 'r-1',
      fingerprints: { resume: 'fp-resume' }
    };
    const cases = [{ caseId: 'c-1' }, { caseId: 'c-2' }];
    const providerResults = [
      { caseId: 'c-1', status: 'completed' },
      { caseId: 'c-2', status: 'provider_failure' }
    ];
    const progress = await writeCaseProgressCheckpoint({
      outputRoot: dir,
      manifest,
      cases,
      providerResults
    });
    assert.equal(progress.runId, 'r-1');
    assert.equal(progress.manifestFingerprint, 'fp-resume');
    assert.equal(progress.cases.total, 2);
    assert.equal(progress.cases.completed, 2);
    assert.equal(progress.cases.byStatus.completed, 1);
    assert.equal(progress.cases.byStatus.provider_failure, 1);
    const onDisk = await readJson(path.join(dir, 'checkpoints', 'progress.json'));
    assert.equal(onDisk.runId, 'r-1');
  });
});
