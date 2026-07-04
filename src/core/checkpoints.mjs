/**
 * Per-case checkpoint store for benchmark runs.
 *
 * Reference implementation of atomic, resumable checkpointing so a
 * crashed benchmark run can resume without re-issuing already-completed
 * cases. Each `providerResult` is written under
 * `<outputRoot>/checkpoints/cases/<safe-caseId>.json` and includes the
 * `manifest.fingerprints.resume` value so an accidental resume against
 * a different run's directory is caught before any work is duplicated.
 *
 * A companion `checkpoints/progress.json` is written after each case so
 * external tools can observe live progress without waiting for the run
 * to finalize.
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';

import { exists, listFilesRecursive, readJson, writeJson } from './fs.mjs';
import { summarizeTokenUsage } from './token-usage.mjs';

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

export async function clearCheckpoints({ outputRoot }) {
  await rm(path.join(outputRoot, 'checkpoints'), {
    recursive: true,
    force: true
  });
}

export function caseCheckpointPath({ outputRoot, caseId }) {
  return path.join(
    outputRoot,
    'checkpoints',
    'cases',
    `${safeFilePart(caseId)}.json`
  );
}

export async function writeCaseCheckpoint({
  outputRoot,
  manifestFingerprint,
  benchmarkCase,
  providerResult
}) {
  await writeJson(caseCheckpointPath({ outputRoot, caseId: benchmarkCase.caseId }), {
    updatedAt: new Date().toISOString(),
    manifestFingerprint,
    case: benchmarkCase,
    providerResult,
    status: providerResult?.status ?? 'unknown'
  });
}

export async function loadCaseCheckpoints({ outputRoot, manifestFingerprint }) {
  const root = path.join(outputRoot, 'checkpoints', 'cases');
  if (!(await exists(root))) return [];
  const files = (await listFilesRecursive(root)).filter((file) =>
    file.endsWith('.json')
  );
  const checkpoints = [];
  for (const file of files) {
    const checkpoint = await readJson(file);
    if (
      checkpoint?.manifestFingerprint &&
      checkpoint.manifestFingerprint !== manifestFingerprint
    ) {
      throw new Error(
        `Checkpoint fingerprint mismatch in ${file}; use a different output directory or --force.`
      );
    }
    if (checkpoint?.case?.caseId && checkpoint?.providerResult?.caseId) {
      checkpoints.push(checkpoint);
    }
  }
  return checkpoints;
}

export async function writeCaseProgressCheckpoint({
  outputRoot,
  manifest,
  cases,
  providerResults
}) {
  const byStatus = {};
  for (const result of providerResults) {
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
  }
  const progress = {
    runId: manifest.runId,
    updatedAt: new Date().toISOString(),
    manifestFingerprint: manifest.fingerprints?.resume ?? null,
    cases: {
      total: cases.length,
      completed: providerResults.length,
      remaining: Math.max(cases.length - providerResults.length, 0),
      byStatus
    },
    tokenUsage: summarizeTokenUsage({ cases, providerResults }).total
  };
  await writeJson(path.join(outputRoot, 'checkpoints', 'progress.json'), progress);
  return progress;
}
