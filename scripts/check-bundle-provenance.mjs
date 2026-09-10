#!/usr/bin/env node
/**
 * Every published bundle must pin a harness commit that an outsider can
 * check out. A commit that is reachable only from a pull-request ref, or
 * that a force-push has rewritten, fails here.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { exists } from '../src/core/fs.mjs';

const execFileAsync = promisify(execFile);

async function isAncestor(repoRoot, commit, baseRef) {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', commit, baseRef]);
    return true;
  } catch {
    return false;
  }
}

export async function findBundles(resultsRoot) {
  if (!(await exists(resultsRoot))) return [];
  const bundles = [];
  async function walk(dir) {
    if (await exists(path.join(dir, 'result.json'))) {
      bundles.push(dir);
      return;
    }
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
    }
  }
  await walk(resultsRoot);
  return bundles;
}

export async function checkBundleProvenance({ repoRoot, baseRef, bundles }) {
  const violations = [];
  for (const bundle of bundles) {
    const rel = path.relative(repoRoot, bundle);
    let harness;
    try {
      harness = JSON.parse(await readFile(path.join(bundle, 'result.json'), 'utf8'))?.run?.harness;
    } catch (error) {
      violations.push({ bundle: rel, reason: `unreadable result.json: ${error.message}`, commit: null });
      continue;
    }
    const commit = harness?.commit ?? null;
    if (!commit) {
      violations.push({ bundle: rel, reason: 'missing run.harness.commit', commit: null });
      continue;
    }
    if (harness.dirty === true) {
      violations.push({ bundle: rel, reason: 'produced from a dirty working tree', commit });
    }
    if (!(await isAncestor(repoRoot, commit, baseRef))) {
      violations.push({
        bundle: rel,
        reason: `harness commit is not an ancestor of ${baseRef} (unknown commit or not yet merged)`,
        commit
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const baseIndex = process.argv.indexOf('--base');
  const baseRef = baseIndex === -1 ? 'origin/main' : process.argv[baseIndex + 1];
  const repoRoot = process.cwd();
  const bundles = await findBundles(path.join(repoRoot, 'results'));
  const { ok, violations } = await checkBundleProvenance({ repoRoot, baseRef, bundles });
  if (!ok) {
    console.error(`bundle provenance: ${violations.length} violation(s) against ${baseRef}\n`);
    for (const v of violations) console.error(`  ${v.bundle}\n    ${v.reason}${v.commit ? `\n    commit ${v.commit}` : ''}`);
    console.error(
      '\nPublish numbers in a PR separate from the harness change that produced them:\n' +
        '  1. merge the harness change\n  2. check out a clean main\n  3. run\n  4. publish in a follow-up PR'
    );
    process.exit(1);
  }
  console.log(`bundle provenance OK — ${bundles.length} bundle(s) against ${baseRef}`);
}
