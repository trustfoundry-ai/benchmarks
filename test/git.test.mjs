import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { gitDirty, gitRevision } from '../src/core/git.mjs';

const execFileAsync = promisify(execFile);

async function withTempDir(runner) {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-test-'));
  try {
    await runner(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function initFixtureRepo(dir) {
  await execFileAsync('git', ['-C', dir, 'init', '-b', 'main']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'fixture@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Fixture']);
  await writeFile(path.join(dir, 'tracked.txt'), 'committed content\n');
  await execFileAsync('git', ['-C', dir, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'initial commit']);
}

test('gitDirty returns false for a clean fixture repo', async () => {
  await withTempDir(async (dir) => {
    await initFixtureRepo(dir);
    assert.equal(await gitDirty(dir), false);
  });
});

test('gitDirty returns true once an untracked file is added', async () => {
  await withTempDir(async (dir) => {
    await initFixtureRepo(dir);
    await writeFile(path.join(dir, 'untracked.txt'), 'pending content\n');
    assert.equal(await gitDirty(dir), true);
  });
});

test('gitDirty returns null for a directory that is not a git repo', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await gitDirty(dir), null);
  });
});

test('gitDirty returns null for a falsy cwd', async () => {
  assert.equal(await gitDirty(''), null);
  assert.equal(await gitDirty(undefined), null);
});

test('gitRevision returns the commit sha for a fixture repo', async () => {
  await withTempDir(async (dir) => {
    await initFixtureRepo(dir);
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
    assert.equal(await gitRevision(dir), stdout.trim());
  });
});

test('gitRevision returns null for a directory that is not a git repo', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await gitRevision(dir), null);
  });
});

test('gitRevision returns null for a falsy cwd', async () => {
  assert.equal(await gitRevision(''), null);
  assert.equal(await gitRevision(undefined), null);
});
