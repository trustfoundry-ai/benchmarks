#!/usr/bin/env node
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { exists } from '../src/core/fs.mjs';
import { verifyResultBundle } from '../src/core/artifacts.mjs';

const repoRoot = process.cwd();
const resultsRoot = path.join(repoRoot, 'results');

async function findBundles(root) {
  if (!(await exists(root))) return [];
  const bundles = [];
  async function walk(dir) {
    const manifest = path.join(dir, 'manifest.json');
    const result = path.join(dir, 'result.json');
    const hasRaw = (await exists(path.join(dir, 'raw.jsonl'))) ||
      (await exists(path.join(dir, 'raw.jsonl.gz')));
    if ((await exists(manifest)) && hasRaw && (await exists(result))) {
      bundles.push(dir);
      return;
    }
    for (const entry of await readdir(dir)) {
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return bundles;
}

const bundles = await findBundles(resultsRoot);
if (!bundles.length) {
  console.log('No result bundles found.');
  process.exit(0);
}

for (const bundle of bundles) {
  const verification = await verifyResultBundle({
    repoRoot,
    bundleDir: bundle,
    verifyInputs: false
  });
  console.log(`verified ${verification.bundleDir} (${verification.rows} rows)`);
}

// Verify any latest.json pointer files resolve to bundles that exist.
async function findLatestPointers(root) {
  if (!(await exists(root))) return [];
  const pointers = [];
  for (const entry of await readdir(root)) {
    const benchDir = path.join(root, entry);
    if (!(await stat(benchDir)).isDirectory()) continue;
    const pointer = path.join(benchDir, 'latest.json');
    if (await exists(pointer)) pointers.push(pointer);
  }
  return pointers;
}

const pointers = await findLatestPointers(resultsRoot);
for (const pointerPath of pointers) {
  const benchDir = path.dirname(pointerPath);
  const relPointer = path.relative(repoRoot, pointerPath);
  const doc = JSON.parse(await readFile(pointerPath, 'utf8'));
  if (!doc || typeof doc.bundles !== 'object' || doc.bundles === null) {
    throw new Error(`${relPointer}: missing or invalid "bundles" object`);
  }
  const keys = Object.keys(doc.bundles);
  if (keys.length === 0) {
    throw new Error(`${relPointer}: "bundles" object is empty`);
  }
  for (const [key, relBundle] of Object.entries(doc.bundles)) {
    if (typeof relBundle !== 'string' || relBundle.length === 0) {
      throw new Error(`${relPointer}: bundle "${key}" is not a string path`);
    }
    const resolved = path.join(benchDir, relBundle);
    const matched = bundles.some(
      (b) => path.resolve(b) === path.resolve(resolved)
    );
    if (!matched) {
      throw new Error(
        `${relPointer}: bundle "${key}" -> "${relBundle}" does not resolve to a verified bundle`
      );
    }
  }
  console.log(
    `verified pointer ${relPointer} (${keys.length} entries)`
  );
}
