import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeTokenUsage, summarizeTokenUsage } from '../src/core/token-usage.mjs';

test('token usage summary aggregates provider usage by task', () => {
  const cases = [
    { caseId: 'case-1', benchmarkId: 'sample-benchmark', taskId: 'task-a' },
    { caseId: 'case-2', benchmarkId: 'sample-benchmark', taskId: 'task-a' },
    { caseId: 'case-3', benchmarkId: 'sample-benchmark', taskId: 'task-b' }
  ];
  const providerResults = [
    {
      caseId: 'case-1',
      status: 'completed',
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 12,
        cachedInputTokens: 2,
        totalTokens: 30
      }
    },
    {
      caseId: 'case-2',
      status: 'provider_error',
      tokenUsage: {
        inputTokens: 5,
        outputTokens: 100,
        reasoningOutputTokens: 100,
        totalTokens: 105
      }
    },
    {
      caseId: 'case-3',
      status: 'completed',
      tokenUsage: null
    }
  ];

  const summary = summarizeTokenUsage({ cases, providerResults });
  assert.equal(summary.total.cases, 3);
  assert.equal(summary.total.withTokenUsage, 2);
  assert.equal(summary.total.tokens.inputTokens, 15);
  assert.equal(summary.total.tokens.outputTokens, 120);
  assert.equal(summary.total.tokens.reasoningOutputTokens, 112);
  assert.equal(summary.total.tokens.cachedInputTokens, 2);
  assert.equal(summary.total.byStatus.completed, 2);
  assert.equal(summary.total.byStatus.provider_error, 1);

  const taskA = summary.byTask.find((item) => item.taskId === 'task-a');
  assert.equal(taskA.cases, 2);
  assert.equal(taskA.tokens.totalTokens, 135);
  assert.equal(taskA.tokens.reasoningOutputTokens, 112);

  const taskB = summary.byTask.find((item) => item.taskId === 'task-b');
  assert.equal(taskB.withTokenUsage, 0);
  assert.equal(taskB.missingTokenFields.inputTokens, 1);
});

test('normalizeTokenUsage computes totalTokens when only input+output are reported', () => {
  const normalized = normalizeTokenUsage({ inputTokens: 3, outputTokens: 7 });
  assert.equal(normalized.totalTokens, 10);
});

test('normalizeTokenUsage returns null totalTokens when either summand is missing', () => {
  const normalized = normalizeTokenUsage({ inputTokens: 3 });
  assert.equal(normalized.totalTokens, null);
});
