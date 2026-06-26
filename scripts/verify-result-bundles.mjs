#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
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
    const raw = path.join(dir, 'raw.jsonl');
    const result = path.join(dir, 'result.json');
    if ((await exists(manifest)) && (await exists(raw)) && (await exists(result))) {
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
  const verification = await verifyResultBundle({ repoRoot, bundleDir: bundle });
  console.log(`verified ${verification.bundleDir} (${verification.rows} rows)`);
}
