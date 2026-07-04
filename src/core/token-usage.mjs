/**
 * Per-run and per-task token accounting for benchmark harnesses.
 *
 * Reference implementation of the token-usage aggregation the runner
 * emits alongside `provider-results.jsonl` and `scores.json`. Consumers
 * pass in `cases` + `providerResults`; each `providerResult.tokenUsage`
 * is normalized (missing fields are counted separately from zero values),
 * then rolled up per benchmarkId+taskId and into a run-wide total.
 */
const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'cachedInputTokens',
  'totalTokens'
];

function numericOrNull(value) {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function normalizeTokenUsage(usage) {
  const inputTokens = numericOrNull(usage?.inputTokens);
  const outputTokens = numericOrNull(usage?.outputTokens);
  const reportedTotalTokens = numericOrNull(usage?.totalTokens);
  return {
    inputTokens,
    outputTokens,
    reasoningOutputTokens: numericOrNull(usage?.reasoningOutputTokens),
    cachedInputTokens: numericOrNull(usage?.cachedInputTokens),
    totalTokens:
      reportedTotalTokens ??
      (inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null)
  };
}

function emptyAccumulator({ benchmarkId = null, taskId = null } = {}) {
  return {
    benchmarkId,
    taskId,
    cases: 0,
    withTokenUsage: 0,
    byStatus: {},
    tokens: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])),
    missingTokenFields: Object.fromEntries(
      TOKEN_FIELDS.map((field) => [field, 0])
    )
  };
}

function hasAnyTokenUsage(usage) {
  return TOKEN_FIELDS.some((field) => usage[field] !== null);
}

function addResultToAccumulator(accumulator, result) {
  const usage = normalizeTokenUsage(result?.tokenUsage);
  accumulator.cases += 1;
  const status = result?.status ?? 'unknown';
  accumulator.byStatus[status] = (accumulator.byStatus[status] ?? 0) + 1;
  if (hasAnyTokenUsage(usage)) accumulator.withTokenUsage += 1;
  for (const field of TOKEN_FIELDS) {
    if (usage[field] === null) {
      accumulator.missingTokenFields[field] += 1;
    } else {
      accumulator.tokens[field] += usage[field];
    }
  }
}

function finalizeAccumulator(accumulator) {
  return {
    benchmarkId: accumulator.benchmarkId,
    taskId: accumulator.taskId,
    cases: accumulator.cases,
    withTokenUsage: accumulator.withTokenUsage,
    byStatus: accumulator.byStatus,
    tokens: accumulator.tokens,
    missingTokenFields: accumulator.missingTokenFields
  };
}

export function summarizeTokenUsage({ cases = [], providerResults = [] } = {}) {
  const caseById = new Map(
    cases.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase])
  );
  const total = emptyAccumulator();
  const byTask = new Map();

  for (const result of providerResults) {
    const benchmarkCase = caseById.get(result?.caseId);
    const benchmarkId = benchmarkCase?.benchmarkId ?? result?.benchmarkId ?? null;
    const taskId = benchmarkCase?.taskId ?? result?.taskId ?? null;
    const taskKey = `${benchmarkId ?? 'unknown'}:${taskId ?? 'unknown'}`;
    const taskAccumulator =
      byTask.get(taskKey) ?? emptyAccumulator({ benchmarkId, taskId });

    addResultToAccumulator(total, result);
    addResultToAccumulator(taskAccumulator, result);
    byTask.set(taskKey, taskAccumulator);
  }

  return {
    fields: TOKEN_FIELDS,
    total: finalizeAccumulator(total),
    byTask: Array.from(byTask.values())
      .map(finalizeAccumulator)
      .sort((left, right) =>
        `${left.benchmarkId ?? ''}:${left.taskId ?? ''}`.localeCompare(
          `${right.benchmarkId ?? ''}:${right.taskId ?? ''}`
        )
      )
  };
}
