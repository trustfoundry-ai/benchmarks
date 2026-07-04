/**
 * Per-case checkpoint store for benchmark runs.
 *
 * Reference implementation of atomic, resumable checkpointing so a
 * crashed benchmark run can resume without re-issuing already-completed
 * cases. Each `ProviderResult` is written to `<dir>/<caseId>.json` via a
 * tmp-file-then-rename pattern so a mid-write crash cannot corrupt an
 * earlier checkpoint.
 *
 * Opt in by passing `--checkpoint-dir <path>` on the runner CLI. Runs
 * without a checkpoint dir behave exactly as before.
 */
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, exists, listFilesRecursive, readJson, writeJson } from './fs.mjs';

function safeFileName(caseId) {
  return String(caseId).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class CheckpointStore {
  constructor({ dir }) {
    if (!dir) throw new Error('CheckpointStore requires a `dir`');
    this.dir = dir;
  }

  #casePath(caseId) {
    return path.join(this.dir, `${safeFileName(caseId)}.json`);
  }

  async write(caseId, providerResult) {
    await ensureDir(this.dir);
    const finalPath = this.#casePath(caseId);
    const tmpPath = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
    await writeJson(tmpPath, { caseId, providerResult });
    await rename(tmpPath, finalPath);
  }

  async has(caseId) {
    return exists(this.#casePath(caseId));
  }

  async read(caseId) {
    const finalPath = this.#casePath(caseId);
    if (!(await exists(finalPath))) return null;
    const { providerResult } = await readJson(finalPath);
    return providerResult ?? null;
  }

  async readAll() {
    const map = new Map();
    if (!(await exists(this.dir))) return map;
    const files = await listFilesRecursive(this.dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const { caseId, providerResult } = await readJson(file);
        if (caseId) map.set(caseId, providerResult);
      } catch {
        // Skip unreadable files silently — partial writes get cleaned
        // up by rename() atomicity, but a corrupted read shouldn't take
        // down a resume.
      }
    }
    return map;
  }
}
