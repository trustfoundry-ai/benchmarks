import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

test('CITATION.cff, README, and CHANGELOG name the same released version', async () => {
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const released = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  assert.ok(released, 'CHANGELOG has no released version heading');

  const citation = await readFile(path.join(root, 'CITATION.cff'), 'utf8');
  const citationVersion = citation.match(/^version:\s*(\S+)/m)?.[1];
  assert.equal(citationVersion, released, 'CITATION.cff version must be the newest released version');

  const citationDate = citation.match(/^date-released:\s*(\S+)/m)?.[1];
  const releasedDate = changelog.match(/^## \[\d+\.\d+\.\d+\] - (\S+)/m)?.[1];
  assert.equal(citationDate, releasedDate, 'CITATION.cff date-released must match the CHANGELOG entry');

  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const readmeVersion = readme.match(/Latest release:\s*\*\*(\d+\.\d+\.\d+)\*\*/)?.[1];
  assert.equal(readmeVersion, released, 'README status block must name the newest released version');
});

test('package.json version is at or ahead of the newest released version', async () => {
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const released = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)[1];
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(
    compareSemver(pkg.version, released) >= 0,
    `package.json ${pkg.version} is behind released ${released}`
  );
});
