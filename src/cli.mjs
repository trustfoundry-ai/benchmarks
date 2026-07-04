import path from 'node:path';

import { publishResultBundle, verifyResultBundle } from './core/artifacts.mjs';
import { readJson, readJsonl, writeJson, exists } from './core/fs.mjs';
import { retryFailedRun } from './core/retry-failed.mjs';
import {
  buildReport,
  defaultPaths,
  executeRun,
  mergeRuns,
  scoreRun
} from './core/runner.mjs';
import { defaultRegistry } from './core/registry.mjs';

function printHelp() {
  console.log(`TrustFoundry benchmarks

Commands:
  adapters
  run [--benchmark ID] [--provider ID] [--scorer ID]
      [--benchmark-config PATH] [--provider-config PATH] [--scorer-config PATH]
      [--out DIR] [--parallel N] [--limit N] [--offset N] [--run-id ID]
      [--shard-index N] [--shard-count N] [--retries N]
      [--resume | --force]
  score --run DIR [--scorer ID] [--scorer-config PATH]
  publish-result --run DIR --out DIR [--force]
  verify-result DIR
  merge-runs --runs DIR[,DIR,...] --out DIR [--prefer POLICY] [--force]
  retry-failed --run DIR --out DIR [--parallel N] [--retries N] [--force]
  retry-misses --run DIR --out DIR [--parallel N] [--retries N] [--force]
  report --run DIR

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

function stringOption(value) {
  return typeof value === 'string' && value.length ? value : undefined;
}

function repoRoot() {
  return process.cwd();
}

function printAdapters() {
  const sections = [
    ['benchmarks', defaultRegistry.benchmarks],
    ['providers', defaultRegistry.providers],
    ['scorers', defaultRegistry.scorers]
  ];
  for (const [label, adapters] of sections) {
    console.log(`${label}:`);
    for (const adapter of adapters.values()) {
      console.log(`  ${adapter.id} (${adapter.version})`);
    }
  }
}

function runSummaryLine(summary) {
  return {
    total: summary.total,
    scored: summary.scored,
    providerFailures: summary.providerFailures,
    hitAt1: summary.hitAt1,
    hitAt5: summary.hitAt5,
    hitAt10: summary.hitAt10,
    hitAt25: summary.hitAt25,
    mrr: summary.mrr,
    ...(summary.latency_ms ? { latency_ms: summary.latency_ms } : {}),
    ...(summary.server_response_duration_ms
      ? { server_response_duration_ms: summary.server_response_duration_ms }
      : {}),
    ...(summary.token_usage ? { token_usage: summary.token_usage } : {}),
    ...(summary.token_cost ? { token_cost: summary.token_cost } : {})
  };
}

async function runCommand(options) {
  const out = options.out ?? 'runs/trustfoundry-legal-search-case-questions-200';
  const result = await executeRun({
    repoRoot: repoRoot(),
    outDir: out,
    benchmarkId: stringOption(options.benchmark),
    providerId: stringOption(options.provider),
    scorerId: stringOption(options.scorer),
    benchmarkConfigPath:
      stringOption(options['benchmark-config']) ?? defaultPaths().benchmarkConfig,
    providerConfigPath:
      stringOption(options['provider-config']) ?? defaultPaths().providerConfig,
    scorerConfigPath:
      stringOption(options['scorer-config']) ?? defaultPaths().scorerConfig,
    limit: numberOption(options.limit, null),
    offset: numberOption(options.offset, null),
    parallel: numberOption(options.parallel, 4),
    shardIndex: numberOption(options['shard-index'], 0),
    shardCount: numberOption(options['shard-count'], 1),
    retries: numberOption(options.retries, 0),
    runId: stringOption(options['run-id']),
    resume: Boolean(options.resume),
    force: Boolean(options.force)
  });
  console.log(`run: ${path.relative(repoRoot(), result.outDir)}`);
  console.log(JSON.stringify(runSummaryLine(result.scores.summary), null, 2));
}

async function scoreCommand(options) {
  if (!options.run || options.run === true) throw new Error('score requires --run DIR');
  const runDir = String(options.run);
  const overrideScorerId = stringOption(options.scorer);
  const overrideScorerConfigPath = stringOption(options['scorer-config']);
  if (!overrideScorerId && !overrideScorerConfigPath) {
    const scores = await scoreRun({ repoRoot: repoRoot(), runDir });
    console.log(JSON.stringify(scores.summary, null, 2));
    return;
  }
  const resolvedRun = path.resolve(repoRoot(), runDir);
  const manifest = await readJson(path.join(resolvedRun, 'manifest.json'));
  const cases = await readJsonl(path.join(resolvedRun, 'cases.jsonl'));
  const providerResults = await readJsonl(
    path.join(resolvedRun, 'provider-results.jsonl')
  );
  const scorerId = overrideScorerId ?? manifest.scorer?.id ?? 'search-recall';
  const scorerAdapter = defaultRegistry.scorers.get(scorerId);
  if (!scorerAdapter) throw new Error(`Unknown scorer '${scorerId}'`);
  const scorerConfig = overrideScorerConfigPath
    ? await readJson(path.resolve(repoRoot(), overrideScorerConfigPath))
    : {};
  const scores = await scorerAdapter.score({
    manifest,
    cases,
    providerResults,
    outputRoot: resolvedRun,
    config: scorerConfig
  });
  await writeJson(path.join(resolvedRun, 'scores.json'), scores);
  const preflight = (await exists(path.join(resolvedRun, 'preflight.json')))
    ? await readJson(path.join(resolvedRun, 'preflight.json'))
    : null;
  const report = buildReport({
    manifest,
    preflight,
    scores,
    providerResults,
    cases
  });
  await writeJson(path.join(resolvedRun, 'report.json'), report);
  await writeJson(path.join(resolvedRun, 'token-usage.json'), report.tokenUsage);
  console.log(JSON.stringify(scores.summary ?? scores, null, 2));
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
    prefer: stringOption(options.prefer),
    force: Boolean(options.force)
  });
  console.log(`merged: ${path.relative(repoRoot(), result.outDir)}`);
  console.log(JSON.stringify(
    {
      chunks: result.chunkCount,
      ...runSummaryLine(result.scores.summary)
    },
    null,
    2
  ));
}

async function retryFailedCommand(options, { selection = 'failed' } = {}) {
  const label = selection === 'misses' ? 'retry-misses' : 'retry-failed';
  if (!options.run || options.run === true) throw new Error(`${label} requires --run DIR`);
  if (!options.out || options.out === true) throw new Error(`${label} requires --out DIR`);
  const result = await retryFailedRun({
    repoRoot: repoRoot(),
    runDir: options.run,
    outDir: options.out,
    providerConfigPath: stringOption(options['provider-config']),
    scorerConfigPath: stringOption(options['scorer-config']),
    parallel: numberOption(options.parallel, 4),
    retries: numberOption(options.retries, 0),
    force: Boolean(options.force),
    selection
  });
  console.log(`${label}: ${path.relative(repoRoot(), result.outDir)}`);
  console.log(JSON.stringify(
    {
      caseCount: result.caseCount,
      total: result.scores.summary.total,
      scored: result.scores.summary.scored,
      providerFailures: result.scores.summary.providerFailures
    },
    null,
    2
  ));
}

async function reportCommand(options) {
  if (!options.run || options.run === true) throw new Error('report requires --run DIR');
  const reportPath = path.join(path.resolve(repoRoot(), options.run), 'report.json');
  const report = await readJson(reportPath);
  console.log(JSON.stringify(report, null, 2));
}

export async function main(args) {
  const command = args[0] ?? 'help';
  const { options, positionals } = parseArgs(args.slice(1));
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'adapters') return printAdapters();
  if (command === 'run') return runCommand(options);
  if (command === 'score') return scoreCommand(options);
  if (command === 'publish-result') return publishResultCommand(options);
  if (command === 'verify-result') return verifyResultCommand(positionals);
  if (command === 'merge-runs' || command === 'merge') return mergeRunsCommand(options);
  if (command === 'retry-failed') return retryFailedCommand(options);
  if (command === 'retry-misses') return retryFailedCommand(options, { selection: 'misses' });
  if (command === 'report') return reportCommand(options);
  throw new Error(`Unknown command: ${command}`);
}
