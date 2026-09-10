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

import { writeBundleChecksums } from '../src/core/artifacts.mjs';
import { exists, readJson, writeJson } from '../src/core/fs.mjs';

const execFileAsync = promisify(execFile);
async function runGh(command, args) {
  await execFileAsync(command, args);
}

const USAGE =
  'usage: upload-raw-assets.mjs --tag <release-tag> [--repo owner/name] [--dry-run] <bundle-dir>...';

// Bundle paths are `results/<suite>/<date>/<target>`; flattening that into a
// single name with `__` separators is what makes asset names unique within
// a release (a release's assets are a flat namespace).
export function assetNameFor(repoRoot, bundleDir) {
  const rel = path.relative(path.join(repoRoot, 'results'), bundleDir);
  return `${rel.split(path.sep).join('__')}__raw.jsonl.gz`;
}

// The href a bundle's asset will live at, fully determined by repo, tag, and
// bundle path -- knowable before any upload happens, so a caller that already
// knows its release tag (e.g. a future publish step) can compute it up front
// rather than only after uploadRawAsset runs.
export function hrefFor({ repo, tag, repoRoot, bundleDir }) {
  const assetName = assetNameFor(repoRoot, bundleDir);
  return `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
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
  const href = hrefFor({ repo, tag, repoRoot, bundleDir });

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
  // checksums.txt carries a digest line for manifest.json itself; the write
  // above just changed that file's bytes, so the checksums file has to be
  // regenerated or it fails its own manifest.json line on the next `shasum
  // -c` -- indistinguishable, to a reader, from real tampering.
  await writeBundleChecksums({ bundleDir, rawArtifactPath: 'raw.jsonl.gz' });
  return href;
}

// Parses argv left to right so a flag's value is always the token that
// immediately follows it, never located by a whole-argv scan. That is what
// makes a malformed invocation (a flag-shaped token where a value belongs, a
// flag with no value, a repeated flag) fail loudly instead of silently
// reassigning which token means what and which tokens fall through as
// bundle directories.
export function parseArgs(argv) {
  const valueFlags = new Set(['--tag', '--repo']);
  let tag;
  let repo;
  let dryRun = false;
  const bundles = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--tag') {
        if (tag !== undefined) throw new Error('--tag given more than once');
        tag = value;
      } else {
        if (repo !== undefined) throw new Error('--repo given more than once');
        repo = value;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    }
    bundles.push(arg);
  }

  if (tag === undefined) throw new Error('missing required --tag <release-tag>');
  if (!bundles.length) throw new Error('at least one bundle directory is required');

  return { tag, repo: repo ?? 'trustfoundry-ai/benchmarks', dryRun, bundles };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }

  const { tag, repo, dryRun, bundles } = parsed;
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
