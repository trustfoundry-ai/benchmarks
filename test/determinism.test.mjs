import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, acc);
    else if (entry.name.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}

test('the runtime path contains no nondeterminism source', async () => {
  const offenders = [];
  for (const file of await sourceFiles(path.join(root, 'src'))) {
    // src/testing is fixtures for downstream consumers, not the runtime path.
    if (file.includes(`${path.sep}testing${path.sep}`)) continue;
    const body = await readFile(file, 'utf8');
    if (/Math\.random\s*\(/.test(body)) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, [], 'Math.random() in the runtime path breaks deterministic case selection');
});
