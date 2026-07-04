/**
 * Run manifest construction for benchmark harnesses.
 *
 * Reference implementation of the manifest the runner writes to
 * `manifest.json` at the start of a run and finalizes at the end. The
 * manifest pins the identity and versions of the benchmark, provider, and
 * scorer used, plus sha256s of their config files, so downstream tooling
 * can distinguish runs and verify that a `retry` / `merge` operates on
 * runs with the same inputs.
 *
 * `fingerprints.compatibility` collapses those identity fields into a
 * single hash for cheap equality checks — see `assertCompatibleManifest`.
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

const HARNESS_NAME = '@trustfoundry-ai/benchmarks';
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

function fingerprintInputs(manifest) {
  return {
    benchmark: {
      id: manifest.benchmark?.id ?? null,
      version: manifest.benchmark?.version ?? null,
      configSha256: manifest.benchmark?.configSha256 ?? null
    },
    provider: {
      id: manifest.provider?.id ?? null,
      version: manifest.provider?.version ?? null,
      configSha256: manifest.provider?.configSha256 ?? null
    },
    scorer: {
      id: manifest.scorer?.id ?? null,
      configSha256: manifest.scorer?.configSha256 ?? null
    }
  };
}

export function computeFingerprints(manifest) {
  return {
    compatibility: sha256Text(canonicalStringify(fingerprintInputs(manifest)))
  };
}

export async function buildManifest({
  repoRoot,
  runId,
  runKind = 'execution',
  benchmark,
  benchmarkConfig,
  providerDescription,
  paths,
  parallel,
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
  const manifest = {
    schema_version: SCHEMA_VERSION,
    runId,
    run_id: runId,
    runKind,
    harness: {
      name: HARNESS_NAME,
      commit: harnessCommit,
      version: harnessVersion,
      ...(includeHostname ? { hostname: hostname() } : {})
    },
    benchmark: {
      id: benchmark.id,
      version: benchmark.version,
      configPath: paths.benchmarkConfigPath,
      configSha256: await sha256File(paths.benchmarkConfigFile),
      sourceRoot: relativePath(repoRoot, benchmark.sourceRoot),
      sourceFiles: dataFiles,
      datasetSize: benchmarkConfig.datasetSize ?? null,
      datasetNames: benchmarkConfig.datasetNames ?? null,
      splits: benchmarkConfig.splits ?? null,
      queryTransformId: benchmark.queryTransformId ?? null
    },
    provider: {
      ...providerDescription,
      configPath: paths.providerConfigPath,
      configSha256: await sha256File(paths.providerConfigFile)
    },
    scorer: {
      id: scorerId ?? 'search-recall',
      configPath: paths.scorerConfigPath,
      configSha256: await sha256File(paths.scorerConfigFile)
    },
    scheduler: {
      parallel,
      caseCount
    },
    startedAt: new Date().toISOString(),
    ...(sourceRuns ? { sourceRuns } : {})
  };
  return {
    ...manifest,
    fingerprints: computeFingerprints(manifest)
  };
}

export function assertCompatibleManifest(left, right, { field = 'compatibility' } = {}) {
  const leftFp = left?.fingerprints?.[field] ?? computeFingerprints(left)[field];
  const rightFp = right?.fingerprints?.[field] ?? computeFingerprints(right)[field];
  if (!leftFp || !rightFp || leftFp !== rightFp) {
    throw new Error(
      `Manifest ${field} fingerprints do not match: ` +
        `${leftFp ?? '(missing)'} vs ${rightFp ?? '(missing)'}`
    );
  }
}
