import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CheckpointStore } from '../src/core/checkpoint.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'checkpoint-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('CheckpointStore round-trips write, has, read', async () => {
  await withTempDir(async (dir) => {
    const store = new CheckpointStore({ dir });
    assert.equal(await store.has('case-1'), false);
    await store.write('case-1', { status: 'completed', caseId: 'case-1' });
    assert.equal(await store.has('case-1'), true);
    const result = await store.read('case-1');
    assert.equal(result.status, 'completed');
  });
});

test('CheckpointStore.readAll returns a map of all checkpoints', async () => {
  await withTempDir(async (dir) => {
    const store = new CheckpointStore({ dir });
    await store.write('case-1', { status: 'completed' });
    await store.write('case-2', { status: 'provider_failure' });
    const all = await store.readAll();
    assert.equal(all.size, 2);
    assert.equal(all.get('case-1').status, 'completed');
    assert.equal(all.get('case-2').status, 'provider_failure');
  });
});

test('CheckpointStore.readAll on a nonexistent dir returns an empty map', async () => {
  const store = new CheckpointStore({ dir: '/tmp/does-not-exist-checkpoint-test-xyz' });
  const all = await store.readAll();
  assert.equal(all.size, 0);
});

test('CheckpointStore sanitizes caseIds with slashes', async () => {
  await withTempDir(async (dir) => {
    const store = new CheckpointStore({ dir });
    await store.write('legal-search:case/007', { status: 'completed' });
    assert.equal(await store.has('legal-search:case/007'), true);
    const result = await store.read('legal-search:case/007');
    assert.equal(result.status, 'completed');
  });
});

test('CheckpointStore requires a dir', () => {
  assert.throws(() => new CheckpointStore({}), /requires a `dir`/);
});
