/**
 * Run manifest construction for benchmark harnesses.
 *
 * Reference implementation of the manifest the runner writes to
 * `manifest.json` at the start of a run and finalizes at the end. The
 * manifest pins the identity and versions of the benchmark, provider, and
 * scorer used, plus sha256s of their config files and dataset source
 * files, so downstream tooling can distinguish runs and verify that a
 * `retry` / `merge` / `resume` operates on runs with the same inputs.
 *
 * Three fingerprints are computed:
 *   - `compatibility` — identity + config hashes; two runs with matching
 *     compatibility fingerprints have the same benchmark/provider/scorer
 *     inputs and can be merged, retried against, or meaningfully compared.
 *   - `resume` — compatibility + shard index/count; a resume run must
 *     match the source run's exact shard slice.
 *   - `manifest` — compatibility + full scheduler + runId; unique per run.
 */
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import {
  canonicalStringify,
  relativePath,
  sha256File,
  sha256Text
} from './fs.mjs';

const HARNESS_NAME = '@trustfoundry-ai/benchmarks-harness';
const HARNESS_ORIGIN_URL = 'https://github.com/trustfoundry-ai/benchmarks.git';
const SCHEMA_VERSION = 'trustfoundry.benchmarks.run.v1';

async function gitCommit(repoRoot) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readHarnessVersion(repoRoot) {
  try {
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

function parseComponentBuilds(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, componentValue]) => componentValue !== null)
        .map(([component, componentValue]) => [component, String(componentValue)])
    );
  } catch {
    return {};
  }
}

function compatibilityInputs(manifest) {
  return {
    benchmark: {
      id: manifest.benchmark?.id ?? null,
      version: manifest.benchmark?.version ?? null,
      sourceCommit: manifest.benchmark?.sourceCommit ?? null,
      configSha256: manifest.benchmark?.configSha256 ?? null,
      promptVersion: manifest.benchmark?.promptVersion ?? null,
      materializationVersion: manifest.benchmark?.materializationVersion ?? null
    },
    provider: {
      id: manifest.provider?.id ?? null,
      version: manifest.provider?.version ?? null,
      subject: manifest.provider?.subject ?? null,
      model: manifest.provider?.model ?? null,
      configSha256: manifest.provider?.configSha256 ?? null
    },
    scorer: {
      id: manifest.scorer?.id ?? null,
      version: manifest.scorer?.version ?? null,
      extractionVersion: manifest.scorer?.extractionVersion ?? null,
      configSha256: manifest.scorer?.configSha256 ?? null
    }
  };
}

export function computeFingerprints(manifest) {
  const compatibility = compatibilityInputs(manifest);
  const scheduler = manifest.scheduler ?? {};
  const caseCount = scheduler.caseCount ?? manifest.caseCount ?? null;
  return {
    compatibility: sha256Text(canonicalStringify(compatibility)),
    resume: sha256Text(
      canonicalStringify({
        ...compatibility,
        scheduler: {
          shardIndex: scheduler.shardIndex ?? 0,
          shardCount: scheduler.shardCount ?? 1
        }
      })
    ),
    manifest: sha256Text(
      canonicalStringify({
        runId: manifest.runId ?? manifest.run_id ?? null,
        runKind: manifest.runKind ?? 'execution',
        compatibility,
        scheduler,
        caseCount,
        sourceRuns: manifest.sourceRuns ?? []
      })
    )
  };
}

export async function buildManifest({
  repoRoot,
  runId,
  runKind = 'execution',
  benchmark,
  benchmarkConfig,
  providerDescription,
  scorerDescription = null,
  paths,
  parallel,
  shardIndex = 0,
  shardCount = 1,
  retries = 0,
  caseCount,
  scorerId,
  sourceRuns = null,
  includeHostname = false
}) {
  const sourceFiles = benchmark.sourceFiles ?? [];
  const dataFiles = await Promise.all(
    sourceFiles.map(async (file) => ({
      path: relativePath(repoRoot, file),
      sha256: await sha256File(file)
    }))
  );
  const [harnessCommit, harnessVersion] = await Promise.all([
    gitCommit(repoRoot),
    readHarnessVersion(repoRoot)
  ]);
  const [benchmarkConfigSha256, providerConfigSha256, scorerConfigSha256] =
    await Promise.all([
      paths.benchmarkConfigFile ? sha256File(paths.benchmarkConfigFile) : null,
      paths.providerConfigFile ? sha256File(paths.providerConfigFile) : null,
      paths.scorerConfigFile ? sha256File(paths.scorerConfigFile) : null
    ]);
  const scorer = {
    id: scorerId ?? scorerDescription?.id ?? 'trustfoundry-legal-search',
    ...(scorerDescription ?? {}),
    configPath: paths.scorerConfigPath,
    configSha256: scorerConfigSha256
  };
  const manifest = {
    schema_version: SCHEMA_VERSION,
    runId,
    run_id: runId,
    runKind,
    startedAt: new Date().toISOString(),
    completedAt: null,
    harness: {
      name: HARNESS_NAME,
      originUrl: HARNESS_ORIGIN_URL,
      commit: process.env.GITHUB_SHA ?? process.env.EVAL_HARNESS_SHA ?? harnessCommit,
      version: process.env.EVAL_HARNESS_VERSION ?? harnessVersion,
      ...(includeHostname ? { hostname: hostname() } : {})
    },
    productBuildSha: process.env.PRODUCT_BUILD_SHA ?? null,
    componentBuilds: parseComponentBuilds(process.env.COMPONENT_BUILD_SHAS),
    benchmark: {
      id: benchmark.id,
      version: benchmark.version,
      sourceCommit: benchmark.sourceCommit ?? null,
      promptVersion: benchmark.promptVersion ?? null,
      materializationVersion: benchmark.materializationVersion ?? null,
      configPath: paths.benchmarkConfigPath,
      configSha256: benchmarkConfigSha256,
      sourceRoot: benchmark.sourceRoot ? relativePath(repoRoot, benchmark.sourceRoot) : null,
      sourceFiles: dataFiles,
      datasetSize: benchmarkConfig?.datasetSize ?? null,
      datasetNames: benchmarkConfig?.datasetNames ?? null,
      splits: benchmarkConfig?.splits ?? null,
      queryTransformId: benchmark.queryTransformId ?? null
    },
    provider: {
      ...providerDescription,
      configPath: paths.providerConfigPath,
      configSha256: providerConfigSha256
    },
    scorer,
    scheduler: {
      parallel,
      shardIndex,
      shardCount,
      retries,
      caseCount
    },
    sourceRuns: sourceRuns ?? []
  };
  return {
    ...manifest,
    fingerprints: computeFingerprints(manifest)
  };
}

export function assertCompatibleManifest(
  left,
  right,
  { field = 'compatibility', requireResume = false } = {}
) {
  const key = requireResume ? 'resume' : field;
  const leftFp = left?.fingerprints?.[key] ?? computeFingerprints(left)[key];
  const rightFp = right?.fingerprints?.[key] ?? computeFingerprints(right)[key];
  if (!leftFp || !rightFp || leftFp !== rightFp) {
    throw new Error(
      `Manifest ${key} fingerprints do not match: ` +
        `${leftFp ?? '(missing)'} vs ${rightFp ?? '(missing)'}`
    );
  }
}
