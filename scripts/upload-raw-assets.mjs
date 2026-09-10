#!/usr/bin/env node
/**
 * Upload each bundle's raw.jsonl.gz to a GitHub release and record the
 * resulting URL in the bundle manifest, so a clone carries summaries only
 * while verification stays possible for anyone.
 */
import { execFile } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { exists, readJson, writeJson } from '../src/core/fs.mjs';

const execFileAsync = promisify(execFile);
async function runGh(command, args) {
  await execFileAsync(command, args);
}

// Bundle paths are `results/<suite>/<date>/<target>`; flattening that into a
// single name with `__` separators is what makes asset names unique within
// a release (a release's assets are a flat namespace).
export function assetNameFor(repoRoot, bundleDir) {
  const rel = path.relative(path.join(repoRoot, 'results'), bundleDir);
  return `${rel.split(path.sep).join('__')}__raw.jsonl.gz`;
}

// Uploads one bundle's raw.jsonl.gz to `tag` on `repo` and writes the
// resulting href into that bundle's manifest.json as `artifacts.raw.href`.
// With `dryRun`, prints the command and href it would use and returns the
// href without uploading anything or touching the manifest -- this is the
// only mode that runs against the public repo without a human first
// inspecting the plan.
export async function uploadRawAsset({
  repoRoot,
  bundleDir,
  tag,
  repo,
  dryRun = false,
  exec = runGh
}) {
  const raw = path.join(bundleDir, 'raw.jsonl.gz');
  if (!(await exists(raw))) throw new Error(`${bundleDir}: no raw.jsonl.gz to upload`);
  const assetName = assetNameFor(repoRoot, bundleDir);
  const staged = path.join(path.dirname(raw), assetName);
  const href = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;

  if (dryRun) {
    console.log(
      `[dry run] gh release upload ${tag} ${staged} --repo ${repo} --clobber`
    );
    console.log(`[dry run] would set manifest.artifacts.raw.href = ${href}`);
    return href;
  }

  await copyFile(raw, staged);
  try {
    await exec('gh', ['release', 'upload', tag, staged, '--repo', repo, '--clobber']);
  } finally {
    // The staged copy lives inside a checksummed bundle directory -- leaving
    // it behind after a failed upload would make the bundle's own contents
    // inconsistent with its checksums.txt, so it always comes off, success
    // or failure.
    await rm(staged, { force: true });
  }

  const manifestPath = path.join(bundleDir, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.artifacts.raw.href = href;
  await writeJson(manifestPath, manifest);
  return href;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const valueFlags = new Set(['--tag', '--repo']);
  const dryRun = args.includes('--dry-run');
  const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : undefined;
  const repo = args.includes('--repo')
    ? args[args.indexOf('--repo') + 1]
    : 'trustfoundry-ai/benchmarks';
  const bundles = args.filter((arg, i) => {
    if (arg.startsWith('--')) return false;
    if (i > 0 && valueFlags.has(args[i - 1])) return false;
    return true;
  });

  if (!tag || !bundles.length) {
    console.error(
      'usage: upload-raw-assets.mjs --tag <release-tag> [--repo owner/name] [--dry-run] <bundle-dir>...'
    );
    process.exit(2);
  }

  for (const bundle of bundles) {
    const href = await uploadRawAsset({
      repoRoot: process.cwd(),
      bundleDir: path.resolve(bundle),
      tag,
      repo,
      dryRun
    });
    console.log(`${dryRun ? '[dry run]' : 'uploaded'} ${bundle} -> ${href}`);
  }
}
