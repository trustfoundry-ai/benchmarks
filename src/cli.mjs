import path from 'node:path';

import { publishResultBundle, verifyResultBundle } from './core/artifacts.mjs';
import { retryFailed } from './core/retry.mjs';
import { defaultPaths, executeRun, mergeRuns, scoreRun } from './core/runner.mjs';
import { registry } from './core/registry.mjs';

function printHelp() {
  console.log(`TrustFoundry benchmarks

Commands:
  adapters
  run [--benchmark-config PATH] [--provider-config PATH] [--scorer-config PATH] [--out DIR] [--parallel N] [--limit N] [--offset N] [--run-id ID] [--force]
  score --run DIR
  publish-result --run DIR --out DIR [--force]
  verify-result DIR
  merge-runs --runs DIR[,DIR,...] --out DIR [--prefer POLICY] [--force]
  retry-failed --run DIR --out DIR [--parallel N] [--force]

Defaults:
  benchmark-config ${defaultPaths().benchmarkConfig}
  provider-config  ${defaultPaths().providerConfig}
  scorer-config    ${defaultPaths().scorerConfig}
  out              runs/trustfoundry-legal-search-case-questions-200
  parallel         4
`);
}

function parseArgs(args) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { options, positionals };
}

function numberOption(value, fallback = null) {
  if (value === undefined || value === null || value === true) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number, got ${value}`);
  return parsed;
}

function repoRoot() {
  return process.cwd();
}

function printAdapters() {
  const sections = [
    ['benchmarks', registry.benchmarks],
    ['providers', registry.providers],
    ['scorers', registry.scorers]
  ];
  for (const [label, adapters] of sections) {
    console.log(`${label}:`);
    for (const adapter of adapters.values()) {
      console.log(`  ${adapter.id} (${adapter.version})`);
    }
  }
}

async function runCommand(options) {
  const out = options.out ?? 'runs/trustfoundry-legal-search-case-questions-200';
  const result = await executeRun({
    repoRoot: repoRoot(),
    outDir: out,
    benchmarkConfigPath: options['benchmark-config'] ?? defaultPaths().benchmarkConfig,
    providerConfigPath: options['provider-config'] ?? defaultPaths().providerConfig,
    scorerConfigPath: options['scorer-config'] ?? defaultPaths().scorerConfig,
    limit: numberOption(options.limit, null),
    offset: numberOption(options.offset, null),
    parallel: numberOption(options.parallel, 4),
    runId: options['run-id'] ?? undefined,
    force: Boolean(options.force)
  });
  console.log(`run: ${path.relative(repoRoot(), result.outDir)}`);
  console.log(JSON.stringify({
    total: result.scores.summary.total,
    scored: result.scores.summary.scored,
    providerFailures: result.scores.summary.providerFailures,
    hitAt1: result.scores.summary.hitAt1,
    hitAt5: result.scores.summary.hitAt5,
    hitAt10: result.scores.summary.hitAt10,
    hitAt25: result.scores.summary.hitAt25,
    mrr: result.scores.summary.mrr,
    latency_ms: result.scores.summary.latency_ms,
    ...(result.scores.summary.server_response_duration_ms
      ? { server_response_duration_ms: result.scores.summary.server_response_duration_ms }
      : {}),
    ...(result.scores.summary.token_usage
      ? { token_usage: result.scores.summary.token_usage }
      : {}),
    ...(result.scores.summary.token_cost
      ? { token_cost: result.scores.summary.token_cost }
      : {})
  }, null, 2));
}

async function scoreCommand(options) {
  if (!options.run || options.run === true) throw new Error('score requires --run DIR');
  const scores = await scoreRun({ repoRoot: repoRoot(), runDir: options.run });
  console.log(JSON.stringify(scores.summary, null, 2));
}

async function publishResultCommand(options) {
  if (!options.run || options.run === true) throw new Error('publish-result requires --run DIR');
  if (!options.out || options.out === true) throw new Error('publish-result requires --out DIR');
  const result = await publishResultBundle({
    repoRoot: repoRoot(),
    runDir: options.run,
    outDir: options.out,
    force: Boolean(options.force)
  });
  console.log(`published: ${path.relative(repoRoot(), result.outDir)}`);
}

async function verifyResultCommand(positionals) {
  const bundleDir = positionals[0];
  if (!bundleDir) throw new Error('verify-result requires a result bundle directory');
  const verification = await verifyResultBundle({ repoRoot: repoRoot(), bundleDir });
  console.log(JSON.stringify(verification, null, 2));
}

async function mergeRunsCommand(options) {
  if (!options.runs || options.runs === true) {
    throw new Error('merge-runs requires --runs DIR[,DIR,...]');
  }
  if (!options.out || options.out === true) throw new Error('merge-runs requires --out DIR');
  const runDirs = String(options.runs)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!runDirs.length) throw new Error('merge-runs --runs must list at least one directory');
  const result = await mergeRuns({
    repoRoot: repoRoot(),
    runDirs,
    outDir: options.out,
    prefer: typeof options.prefer === 'string' ? options.prefer : undefined,
    force: Boolean(options.force)
  });
  console.log(`merged: ${path.relative(repoRoot(), result.outDir)}`);
  console.log(JSON.stringify({
    chunks: result.chunkCount,
    total: result.scores.summary.total,
    scored: result.scores.summary.scored,
    providerFailures: result.scores.summary.providerFailures,
    hitAt1: result.scores.summary.hitAt1,
    hitAt5: result.scores.summary.hitAt5,
    hitAt10: result.scores.summary.hitAt10,
    hitAt25: result.scores.summary.hitAt25,
    mrr: result.scores.summary.mrr,
    ...(result.scores.summary.token_usage
      ? { token_usage: result.scores.summary.token_usage }
      : {}),
    ...(result.scores.summary.token_cost
      ? { token_cost: result.scores.summary.token_cost }
      : {})
  }, null, 2));
}

export async function main(args) {
  const command = args[0] ?? 'help';
  const { options, positionals } = parseArgs(args.slice(1));
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'adapters') {
    printAdapters();
    return;
  }
  if (command === 'run') {
    await runCommand(options);
    return;
  }
  if (command === 'score') {
    await scoreCommand(options);
    return;
  }
  if (command === 'publish-result') {
    await publishResultCommand(options);
    return;
  }
  if (command === 'verify-result') {
    await verifyResultCommand(positionals);
    return;
  }
  if (command === 'merge-runs') {
    await mergeRunsCommand(options);
    return;
  }
  if (command === 'retry-failed') {
    await retryFailedCommand(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function retryFailedCommand(options) {
  if (!options.run || options.run === true) throw new Error('retry-failed requires --run DIR');
  if (!options.out || options.out === true) throw new Error('retry-failed requires --out DIR');
  const result = await retryFailed({
    repoRoot: repoRoot(),
    runDir: options.run,
    outDir: options.out,
    parallel: numberOption(options.parallel, 4),
    force: Boolean(options.force)
  });
  console.log(`retried: ${path.relative(repoRoot(), result.outDir)}`);
  console.log(JSON.stringify({
    caseCount: result.caseCount,
    total: result.scores.summary.total,
    scored: result.scores.summary.scored,
    providerFailures: result.scores.summary.providerFailures
  }, null, 2));
}
