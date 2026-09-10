import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);

// Anything not a bare fragment, an absolute URL, or a mail/tel scheme is a path
// this repository has to be able to resolve on its own.
const LINK = /\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function markdownFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

test('every relative link in a markdown file resolves', () => {
  const broken = [];
  let checked = 0;

  for (const file of markdownFiles(repoRoot)) {
    const body = readFileSync(file, 'utf8');
    for (const match of body.matchAll(LINK)) {
      const target = match[1];
      if (EXTERNAL.test(target)) continue;
      checked += 1;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      if (!existsSync(resolved)) {
        broken.push(`${path.relative(repoRoot, file)} -> ${target}`);
      }
    }
  }

  assert.ok(checked > 0, 'link checker found no relative links to check');
  assert.deepEqual(broken, [], `broken relative links:\n  ${broken.join('\n  ')}`);
});
