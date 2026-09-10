import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- entrypoint.sh, driven under DRY_RUN=1 ----
//
// These invoke the real entrypoint.sh, which itself invokes the real
// bin/benchmarks.mjs against this repo's actual suites/ and configs/ trees.
// DRY_RUN=1 makes resolve-target run for real while skipping `run` /
// `publish-result` / `verify-result`, so a suite that is wired correctly
// resolves here even though nothing is actually executed. No network,
// no TF_API_KEY validation beyond presence.

function runEntrypoint(config, env = {}) {
  return execFileAsync('bash', ['entrypoint.sh'], {
    env: { ...process.env, TF_API_KEY: 'test-key-not-used', BENCHMARK_CONFIG: config, DRY_RUN: '1', ...env }
  });
}

test('the case-name suite resolves in the container', async () => {
  const { stdout } = await runEntrypoint('trustfoundry-case-name-lookup/public-8850');
  assert.match(stdout, /trustfoundry-case-name-lookup\/public-8850/);
  assert.match(stdout, /configs\/scorers\/trustfoundry-case-name-lookup\.json/);
});

test('a legal-search target resolves with its own scorer config', async () => {
  const { stdout } = await runEntrypoint('trustfoundry-legal-search/laws-5k');
  assert.match(stdout, /trustfoundry-legal-search\/laws-5k/);
  assert.match(stdout, /configs\/scorers\/trustfoundry-legal-search\.json/);
});

test('all resolves only runnable targets', async () => {
  const { stdout } = await runEntrypoint('all');
  assert.doesNotMatch(stdout, /anthropic-legal-search/);
  assert.match(stdout, /trustfoundry-legal-search\/laws-5k/);
});

test('all resolves exactly the eleven real targets and no vendor config', async () => {
  const { stdout } = await runEntrypoint('all');
  // Neither of the five vendor adapter directories is a suite in the
  // registry, so none of their configs can appear no matter how the
  // config tree on disk is laid out.
  for (const vendor of [
    'anthropic-legal-search',
    'exa-legal-search-aggregators-only',
    'openai-legal-search',
    'parallel-legal-search-aggregators-only',
    'parallel-legal-search-primary-only'
  ]) {
    assert.doesNotMatch(stdout, new RegExp(vendor));
  }

  const resolvedHeaders = stdout.match(/^=== .+ ===$/gm) ?? [];
  assert.equal(resolvedHeaders.length, 11);

  for (const target of [
    'trustfoundry-legal-search/case-questions-200',
    'trustfoundry-legal-search/case-questions-5k',
    'trustfoundry-legal-search/key-facts-200',
    'trustfoundry-legal-search/key-facts-5k',
    'trustfoundry-legal-search/laws-200',
    'trustfoundry-legal-search/laws-5k',
    'trustfoundry-legal-search/regs-200',
    'trustfoundry-legal-search/regs-5k',
    'trustfoundry-case-name-lookup/public-8850',
    'trustfoundry-case-name-lookup/negatives-50',
    'trustfoundry-case-name-lookup/public-1050'
  ]) {
    assert.match(stdout, new RegExp(`=== ${target.replace('/', '\\/')} ===`));
  }

  // Every resolved target — both suites — carries its own scorer config,
  // never a default or another suite's.
  assert.match(stdout, /configs\/scorers\/trustfoundry-legal-search\.json/);
  assert.match(stdout, /configs\/scorers\/trustfoundry-case-name-lookup\.json/);
});

test('<suite>/all resolves only that suite\'s targets', async () => {
  const { stdout } = await runEntrypoint('trustfoundry-case-name-lookup/all');
  assert.match(stdout, /trustfoundry-case-name-lookup\/public-8850/);
  assert.match(stdout, /trustfoundry-case-name-lookup\/negatives-50/);
  assert.match(stdout, /trustfoundry-case-name-lookup\/public-1050/);
  assert.doesNotMatch(stdout, /trustfoundry-legal-search\//);

  const resolvedHeaders = stdout.match(/^=== .+ ===$/gm) ?? [];
  assert.equal(resolvedHeaders.length, 3);
});

test('an unknown target lists valid targets and exits non-zero', async () => {
  await assert.rejects(runEntrypoint('nope/nope'), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr + error.stdout, /trustfoundry-case-name-lookup\/public-8850/);
    return true;
  });
});

test('an unknown suite in <suite>/all lists valid targets and exits non-zero', async () => {
  await assert.rejects(runEntrypoint('nope/all'), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr + error.stdout, /trustfoundry-legal-search\/laws-5k/);
    return true;
  });
});

test('DRY_RUN prints resolved targets without running anything', async () => {
  const { stdout } = await runEntrypoint('trustfoundry-case-name-lookup/negatives-50');
  assert.match(stdout, /benchmarks entrypoint done/);
  // `doesNotMatch(stdout, /uploading/)` would pass here regardless of
  // DRY_RUN, since OUTPUT_BUNDLE_URI is never set in this test file — it
  // proves nothing about the short-circuit. `pnpm benchmark run` prints
  // `run: <outDir>` on stdout if and only if it actually executes
  // (src/cli.mjs's runCommand, after a real executeRun call); its absence
  // is the signal that `run` / `publish-result` / `verify-result` never
  // fired.
  assert.doesNotMatch(stdout, /(^|\n)run: /);
});

test('TF_API_KEY is required', async () => {
  await assert.rejects(
    execFileAsync('bash', ['entrypoint.sh'], {
      env: { ...process.env, TF_API_KEY: '', BENCHMARK_CONFIG: 'all', DRY_RUN: '1' }
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /TF_API_KEY is required/);
      return true;
    }
  );
});
