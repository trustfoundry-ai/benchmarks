/**
 * Scheduler helpers for benchmark harnesses.
 *
 * Reference implementation of the parallel/shard/retry scheduler shape
 * used by the runner. External consumers can import these to normalize
 * their own CLI arg shapes into the runner's expected inputs, or to
 * apply the same shard slicing to their own case arrays.
 */
export function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizeScheduler({
  parallel = 1,
  shardIndex = 0,
  shardCount = 1,
  retries = 0
} = {}) {
  const normalizedShardCount = positiveInteger(shardCount, 1);
  const normalizedShardIndex = nonNegativeInteger(shardIndex, 0);
  if (normalizedShardIndex >= normalizedShardCount) {
    throw new Error(
      `Invalid shard index ${normalizedShardIndex}; expected 0 to ${normalizedShardCount - 1}.`
    );
  }
  return {
    parallel: positiveInteger(parallel, 1),
    shardIndex: normalizedShardIndex,
    shardCount: normalizedShardCount,
    retries: nonNegativeInteger(retries, 0)
  };
}

export function applyShard(cases, { shardIndex, shardCount }) {
  if (shardCount <= 1) return cases;
  return cases.filter((_case, index) => index % shardCount === shardIndex);
}

export async function mapWithConcurrency(items, parallel, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, () => worker())
  );
  return results;
}
