import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// package.json is what `pnpm pack` names the release tarball after, what an
// install from the tag self-reports, and what every run manifest records as
// `harness.version`. A version that runs ahead of the newest release puts a
// number on all three that was never released, so the two must be equal and
// the bump belongs in the release change itself.
test('package.json version is the newest released version', async () => {
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const released = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)[1];
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, released, 'package.json must name the newest released version');
});
