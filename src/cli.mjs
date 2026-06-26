import path from 'node:path';

import { publishResultBundle, verifyResultBundle } from './core/artifacts.mjs';
import { defaultPaths, executeRun, scoreRun } from './core/runner.mjs';
import { registry } from './core/registry.mjs';

function printHelp() {
  console.log(`TrustFoundry benchmarks

Commands:
  adapters
  run [--benchmark-config PATH] [--provider-config PATH] [--scorer-config PATH] [--out DIR] [--parallel N] [--limit N] [--run-id ID] [--force]
  score --run DIR
  publish-result --run DIR --out DIR [--force]
  verify-result DIR

Defaults:
  benchmark-config ${defaultPaths().benchmarkConfig}
  provider-config  ${defaultPaths().providerConfig}
  scorer-config    ${defaultPaths().scorerConfig}
  out              runs/public-search-200
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
  const out = options.out ?? 'runs/public-search-200';
  const result = await executeRun({
    repoRoot: repoRoot(),
    outDir: out,
    benchmarkConfigPath: options['benchmark-config'] ?? defaultPaths().benchmarkConfig,
    providerConfigPath: options['provider-config'] ?? defaultPaths().providerConfig,
    scorerConfigPath: options['scorer-config'] ?? defaultPaths().scorerConfig,
    limit: numberOption(options.limit, null),
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
    latency_ms: result.scores.summary.latency_ms
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
  throw new Error(`Unknown command: ${command}`);
}
