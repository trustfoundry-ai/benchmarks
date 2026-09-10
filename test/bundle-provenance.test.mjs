import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { checkBundleProvenance } from '../scripts/check-bundle-provenance.mjs';

const execFileAsync = promisify(execFile);

async function git(repoRoot, args) {
  return execFileAsync('git', ['-C', repoRoot, ...args]);
}

// A throwaway git repo with its own local identity, so the commit succeeds
// on a machine with no global `user.email` / `user.name` configured.
async function makeRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prov-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'prov-test@example.com']);
  await git(root, ['config', 'user.name', 'prov-test']);
  return root;
}

// Commits whatever is currently on disk (an empty commit is fine — these
// tests only need real, distinct shas and real ancestry, not real content)
// and returns the resulting sha.
async function commit(root, message) {
  await git(root, ['commit', '-q', '--allow-empty', '-m', message]);
  const { stdout } = await git(root, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function writeBundle(root, commitSha, dirty = false) {
  const dir = path.join(root, 'results', 'suite', '2026-01-01', 'target');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify({ run: { harness: { commit: commitSha, dirty } } })
  );
  return dir;
}

test('a bundle pinning a commit that is an ancestor of base is not a violation', async (t) => {
  const root = await makeRepo(t);
  const tip = await commit(root, 'first');
  const dir = await writeBundle(root, tip);

  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'main', bundles: [dir] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

test('a bundle pinning a real commit that base does not contain is a violation', async (t) => {
  const root = await makeRepo(t);
  await commit(root, 'first');
  await git(root, ['checkout', '-q', '-b', 'side']);
  const sideTip = await commit(root, 'side change');
  await git(root, ['checkout', '-q', 'main']);
  const dir = await writeBundle(root, sideTip);

  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'main', bundles: [dir] });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].commit, sideTip);
  assert.match(res.violations[0].reason, /not an ancestor/);
});

test('a bundle pinning a sha absent from the clone is a violation distinguishable from a real non-ancestor', async (t) => {
  const root = await makeRepo(t);
  await commit(root, 'first');
  const unknownSha = 'f'.repeat(40);
  const dir = await writeBundle(root, unknownSha);

  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'main', bundles: [dir] });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].commit, unknownSha);
  assert.match(res.violations[0].reason, /unknown to this clone/);
  assert.doesNotMatch(res.violations[0].reason, /not an ancestor/);
});

test('an unresolvable base ref is a configuration error, not a pile of per-bundle violations', async (t) => {
  const root = await makeRepo(t);
  const tip = await commit(root, 'first');
  const dir = await writeBundle(root, tip);

  await assert.rejects(
    checkBundleProvenance({ repoRoot: root, baseRef: 'no-such-ref', bundles: [dir] }),
    /no-such-ref/
  );
});

test('a bundle with no harness commit is a violation', async (t) => {
  const root = await makeRepo(t);
  await commit(root, 'first');
  const dir = await writeBundle(root, null);

  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'main', bundles: [dir] });
  assert.equal(res.ok, false);
  assert.match(res.violations[0].reason, /missing/);
});

test('a bundle produced from a dirty tree is a violation', async (t) => {
  const root = await makeRepo(t);
  const tip = await commit(root, 'first');
  const dir = await writeBundle(root, tip, true);

  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'main', bundles: [dir] });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
  assert.match(res.violations[0].reason, /dirty/);
});
