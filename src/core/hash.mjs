/**
 * Hashing helpers for benchmark harnesses.
 *
 * Reference implementation of the sha256 + canonical-JSON helpers used
 * by the runner to fingerprint configs and manifests. `hashObject`
 * canonicalizes its input (sorted keys) before hashing so semantically
 * identical objects produce identical digests regardless of insertion
 * order.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function stableJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function hashObject(value) {
  return sha256Text(stableJson(value));
}

export async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
