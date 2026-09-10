#!/usr/bin/env node
/**
 * Every published bundle must pin a harness commit that an outsider can
 * check out. A commit that is reachable only from a pull-request ref, or
 * that a force-push has rewritten, fails here.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { exists, findLeafDirs } from '../src/core/fs.mjs';

const execFileAsync = promisify(execFile);

// Resolves `ref` to a commit sha in `repoRoot`, once, up front. Throws a
// configuration error distinguishable from a per-bundle violation: an
// unresolvable base ref (a typo, or a shallow clone that never fetched it)
// means the gate itself cannot run, not that every bundle is in violation.
async function resolveBaseRef(repoRoot, ref) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'rev-parse',
      '--verify',
      `${ref}^{commit}`
    ]);
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `bundle provenance: base ref "${ref}" does not resolve to a commit in ${repoRoot} ` +
        `(fetch it first — a shallow CI checkout needs an explicit fetch of the base branch): ${error.message}`
    );
  }
}

// True when `commit` exists in this clone's object store at all, regardless
// of ancestry. A shallow clone or unfetched history reports the commit as
// unknown here, which is a different situation for a reader than a commit
// this clone has but that base does not contain.
async function commitExists(repoRoot, commit) {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function isAncestor(repoRoot, commit, baseRef) {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', commit, baseRef]);
    return true;
  } catch {
    return false;
  }
}

export async function findBundles(resultsRoot) {
  return findLeafDirs(resultsRoot, (dir) => exists(path.join(dir, 'result.json')));
}

export async function checkBundleProvenance({ repoRoot, baseRef, bundles }) {
  const resolvedBaseRef = await resolveBaseRef(repoRoot, baseRef);
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
    if (!(await commitExists(repoRoot, commit))) {
      violations.push({
        bundle: rel,
        reason: `harness commit is unknown to this clone (shallow clone or unfetched history)`,
        commit
      });
    } else if (!(await isAncestor(repoRoot, commit, resolvedBaseRef))) {
      violations.push({
        bundle: rel,
        reason: `harness commit is not an ancestor of ${baseRef} (not yet merged)`,
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
  try {
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
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
