import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DEFAULT_BENCHMARK_CONFIG,
  DEFAULT_OUT_DIR,
  DEFAULT_PROVIDER_CONFIG,
  DEFAULT_SCORER_CONFIG,
  resolveRunConfig
} from '../src/cli-run-config.mjs';

const execFileAsync = promisify(execFile);

// ---- CLI-level: resolve-target / targets ----
//
// These invoke the real bin/benchmarks.mjs against this repo's actual
// suites/ and configs/ trees — they exercise the wiring (parseTargetRef +
// resolveTarget behind the two new commands), not executeRun. No network,
// no benchmark run.

test('resolve-target prints the config triple as JSON', async () => {
  const { stdout } = await execFileAsync('node', [
    'bin/benchmarks.mjs',
    'resolve-target',
    'trustfoundry-case-name-lookup/negatives-50',
    '--json'
  ]);
  const doc = JSON.parse(stdout);
  assert.equal(doc.benchmarkConfig, 'configs/benchmarks/trustfoundry-case-name-lookup/v2-negatives.json');
  assert.equal(doc.providerConfig, 'configs/providers/trustfoundry-case-name-lookup.json');
  assert.equal(doc.scorerConfig, 'configs/scorers/trustfoundry-case-name-lookup.json');
  assert.equal(doc.bundle, 'negatives-50');
  assert.equal(doc.rows, 50);
});

test('resolve-target without --json prints key=value lines on stdout', async () => {
  const { stdout } = await execFileAsync('node', [
    'bin/benchmarks.mjs',
    'resolve-target',
    'trustfoundry-case-name-lookup/negatives-50'
  ]);
  assert.match(stdout, /^bundle=negatives-50$/m);
  assert.match(stdout, /^rows=50$/m);
});

test('resolve-target exits non-zero and lists valid targets for an unknown target', async () => {
  await assert.rejects(
    execFileAsync('node', ['bin/benchmarks.mjs', 'resolve-target', 'trustfoundry-case-name-lookup/nope']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /negatives-50/);
      assert.equal(error.stdout, '');
      return true;
    }
  );
});

test('resolve-target exits non-zero and lists valid suites for an unknown suite', async () => {
  await assert.rejects(
    execFileAsync('node', ['bin/benchmarks.mjs', 'resolve-target', 'nope/nope']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /trustfoundry-case-name-lookup/);
      assert.match(error.stderr, /trustfoundry-legal-search/);
      return true;
    }
  );
});

test('resolve-target requires a <suite>/<target> positional', async () => {
  await assert.rejects(
    execFileAsync('node', ['bin/benchmarks.mjs', 'resolve-target']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /requires <suite>\/<target>/);
      return true;
    }
  );
});

test('targets lists every suite and target', async () => {
  const { stdout } = await execFileAsync('node', ['bin/benchmarks.mjs', 'targets']);
  assert.match(stdout, /trustfoundry-legal-search\/laws-5k/);
  assert.match(stdout, /trustfoundry-legal-search\/laws-200/);
  assert.match(stdout, /trustfoundry-case-name-lookup\/public-8850/);
  assert.match(stdout, /trustfoundry-case-name-lookup\/negatives-50/);
});

test('targets does not assume a single headline target per suite', async () => {
  const { stdout } = await execFileAsync('node', ['bin/benchmarks.mjs', 'targets']);
  // legal-search declares four headline targets (case-questions-5k,
  // key-facts-5k, laws-5k, regs-5k) -- all four must be listed with the
  // headline tag, not just one.
  for (const headline of ['case-questions-5k', 'key-facts-5k', 'laws-5k', 'regs-5k']) {
    const line = stdout.split('\n').find((l) => l.includes(`trustfoundry-legal-search/${headline}`));
    assert.ok(line, `expected a line for ${headline}`);
    assert.match(line, /headline/);
  }
});

test('targets --ids prints exactly one <suite>/<target> reference per line', async () => {
  const { stdout } = await execFileAsync('node', ['bin/benchmarks.mjs', 'targets', '--ids']);
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  // Nothing else on any line: no suite header, no row counts, no tags --
  // a consumer can build an array straight from these lines with no
  // parsing beyond splitting on newlines.
  for (const line of lines) {
    assert.match(line, /^[a-z0-9-]+\/[a-z0-9-]+$/);
  }
  assert.equal(lines.length, 11);
  assert.ok(lines.includes('trustfoundry-legal-search/laws-5k'));
  assert.ok(lines.includes('trustfoundry-case-name-lookup/public-8850'));
  assert.ok(lines.includes('trustfoundry-case-name-lookup/negatives-50'));
  assert.ok(lines.includes('trustfoundry-case-name-lookup/public-1050'));
});

// ---- Unit-level: run --target precedence ----
//
// resolveRunConfig is the pure precedence decision runCommand delegates
// to, split out precisely so it can be tested without executeRun (no
// network, no benchmark execution, no provider adapter). `resolved` here
// is the shape resolveTargetOption returns, constructed by hand rather
// than routed through the registry, since the registry's own resolution
// behavior is covered by test/suites.test.mjs and by the CLI-level
// resolve-target tests above.

const fakeResolved = {
  benchmarkConfig: 'configs/benchmarks/trustfoundry-case-name-lookup/v2-negatives.json',
  providerConfig: 'configs/providers/trustfoundry-case-name-lookup.json',
  scorerConfig: 'configs/scorers/trustfoundry-case-name-lookup.json',
  rows: 50,
  bundle: 'negatives-50'
};

test('no --target and no explicit flags reproduces today\'s defaults unchanged', () => {
  const result = resolveRunConfig({}, null);
  assert.deepEqual(result, {
    outDir: DEFAULT_OUT_DIR,
    benchmarkConfigPath: DEFAULT_BENCHMARK_CONFIG,
    providerConfigPath: DEFAULT_PROVIDER_CONFIG,
    scorerConfigPath: DEFAULT_SCORER_CONFIG
  });
});

test('--target alone resolves all three config paths and the out dir from the registry', () => {
  const result = resolveRunConfig({}, fakeResolved);
  assert.deepEqual(result, {
    outDir: 'runs/negatives-50',
    benchmarkConfigPath: fakeResolved.benchmarkConfig,
    providerConfigPath: fakeResolved.providerConfig,
    scorerConfigPath: fakeResolved.scorerConfig
  });
});

test('an explicit --benchmark-config overrides --target for that one field only', () => {
  const result = resolveRunConfig({ 'benchmark-config': 'configs/benchmarks/custom.json' }, fakeResolved);
  assert.equal(result.benchmarkConfigPath, 'configs/benchmarks/custom.json');
  assert.equal(result.providerConfigPath, fakeResolved.providerConfig);
  assert.equal(result.scorerConfigPath, fakeResolved.scorerConfig);
});

test('an explicit --provider-config overrides --target for that one field only', () => {
  const result = resolveRunConfig({ 'provider-config': 'configs/providers/custom.json' }, fakeResolved);
  assert.equal(result.benchmarkConfigPath, fakeResolved.benchmarkConfig);
  assert.equal(result.providerConfigPath, 'configs/providers/custom.json');
  assert.equal(result.scorerConfigPath, fakeResolved.scorerConfig);
});

test('an explicit --scorer-config overrides --target for that one field only', () => {
  const result = resolveRunConfig({ 'scorer-config': 'configs/scorers/custom.json' }, fakeResolved);
  assert.equal(result.benchmarkConfigPath, fakeResolved.benchmarkConfig);
  assert.equal(result.providerConfigPath, fakeResolved.providerConfig);
  assert.equal(result.scorerConfigPath, 'configs/scorers/custom.json');
});

test('an explicit --out overrides the --target-derived out dir', () => {
  const result = resolveRunConfig({ out: 'runs/custom-dir' }, fakeResolved);
  assert.equal(result.outDir, 'runs/custom-dir');
});

test('all three explicit flags with no --target win over the operational defaults', () => {
  const options = {
    'benchmark-config': 'configs/benchmarks/custom.json',
    'provider-config': 'configs/providers/custom.json',
    'scorer-config': 'configs/scorers/custom.json'
  };
  const result = resolveRunConfig(options, null);
  assert.deepEqual(result, {
    outDir: DEFAULT_OUT_DIR,
    benchmarkConfigPath: 'configs/benchmarks/custom.json',
    providerConfigPath: 'configs/providers/custom.json',
    scorerConfigPath: 'configs/scorers/custom.json'
  });
});

test('a flag present as a valueless boolean does not count as an explicit override', () => {
  // parseArgs sets options[key] = true when a --flag has no following
  // value (or the next token is itself a --flag). stringOption must treat
  // that as "not given," or a bare `--benchmark-config` with no path would
  // silently win over --target instead of erroring or falling through.
  const result = resolveRunConfig({ 'benchmark-config': true }, fakeResolved);
  assert.equal(result.benchmarkConfigPath, fakeResolved.benchmarkConfig);
});

test('a valueless --out does not count as an explicit override either', () => {
  // Same trap as above, for outDir specifically: a bare `--out` with
  // nothing after it must fall through to the --target-derived path (or
  // the default, with no target), not set outDir to the boolean true.
  const withTarget = resolveRunConfig({ out: true }, fakeResolved);
  assert.equal(withTarget.outDir, `runs/${fakeResolved.bundle}`);

  const withoutTarget = resolveRunConfig({ out: true }, null);
  assert.equal(withoutTarget.outDir, DEFAULT_OUT_DIR);
});
