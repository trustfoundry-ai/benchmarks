/**
 * Git helpers for benchmark harnesses.
 *
 * Reference implementation of the git-revision lookup the runner uses
 * when embedding the harness commit sha into a manifest. Returns null
 * on any failure (missing git, detached HEAD, no repo) rather than
 * throwing.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function gitRevision(cwd) {
  if (!cwd) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
