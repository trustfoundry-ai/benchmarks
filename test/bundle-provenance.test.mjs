import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkBundleProvenance } from '../scripts/check-bundle-provenance.mjs';

async function bundleWith(commit, dirty = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'prov-'));
  const dir = path.join(root, 'results', 'suite', '2026-01-01', 'target');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify({ run: { harness: { commit, dirty } } })
  );
  return { root, dir };
}

test('a bundle pinning an unknown commit is a violation', async () => {
  const { root, dir } = await bundleWith('0'.repeat(40));
  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'HEAD', bundles: [dir] });
  assert.equal(res.ok, false);
  assert.match(res.violations[0].reason, /not an ancestor|unknown commit/);
});

test('a bundle with no harness commit is a violation', async () => {
  const { root, dir } = await bundleWith(null);
  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'HEAD', bundles: [dir] });
  assert.equal(res.ok, false);
  assert.match(res.violations[0].reason, /missing/);
});

test('a bundle produced from a dirty tree is a violation', async () => {
  const { root, dir } = await bundleWith('0'.repeat(40), true);
  const res = await checkBundleProvenance({ repoRoot: root, baseRef: 'HEAD', bundles: [dir] });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /dirty/.test(v.reason)));
});
