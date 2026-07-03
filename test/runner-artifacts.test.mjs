import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executeRun } from '../src/core/runner.mjs';
import { registry } from '../src/core/registry.mjs';

// Sanity: the executeRun code path materializes provider result.artifacts
// entries to disk under the run directory, using the artifact.path as a
// relative destination. Uses a tiny in-memory fixture: a fake benchmark
// adapter loads one case, a fake provider returns an artifact.

async function withFixture(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-artifacts-'));
  try {
    // Fake benchmark: loads exactly one case, no filesystem source files.
    const benchmark = {
      id: 'fake-artifact-bench',
      version: 'v1',
      materializationVersion: 'v1',
      async loadCases() {
        return {
          benchmark: {
            id: this.id,
            version: this.version,
            sourceRoot: tmp,
            sourceFiles: [],
            materializationVersion: this.materializationVersion,
            queryTransformId: null
          },
          inventory: { benchmark: this.id, records: [], summary: {} },
          cases: [
            {
              caseId: 'fake:case:1',
              benchmarkId: 'fake-artifact-bench',
              prompt: 'q',
              split: 'test',
              metadata: {
                datasetName: 'fake',
                datasetIndex: 0,
                doc_type: 'case',
                field: 'q',
                model_type: 'case_question',
                state: 'MI',
                expected: { kind: 'exact', canonical_citation: '1 Mich. 1', alternates: [] }
              },
              scoringHints: { kind: 'search-recall', outputMode: 'json' }
            }
          ]
        };
      }
    };
    // Fake provider: returns one artifact per case.
    const provider = {
      id: 'fake-artifact-provider',
      version: 'v1',
      async describe() {
        return { id: this.id, version: this.version, target: 'fake' };
      },
      async executeCase({ benchmarkCase }) {
        const now = new Date().toISOString();
        return {
          caseId: benchmarkCase.caseId,
          status: 'completed',
          rawOutput: { request: { query: 'q' }, httpStatus: 200 },
          finalOutputText: JSON.stringify({
            query: 'q',
            total_available: 1,
            result_count: 1,
            results: [{ rank: 1, citation: '1 Mich. 1', citations: ['1 Mich. 1'] }]
          }),
          artifacts: [
            {
              path: 'raw-responses/fake_case_1.json',
              content: JSON.stringify({ hello: 'world', caseId: benchmarkCase.caseId })
            }
          ],
          providerMetadata: { httpStatus: 200 },
          timing: { startedAt: now, completedAt: now, durationMs: 10 },
          error: null
        };
      }
    };

    registry.benchmarks.set(benchmark.id, benchmark);
    registry.providers.set(provider.id, provider);

    // Minimal config files: point at real scorer config so validation passes.
    const bcPath = path.join(tmp, 'benchmark.json');
    const pcPath = path.join(tmp, 'provider.json');
    await fs.writeFile(bcPath, JSON.stringify({ benchmarkId: benchmark.id }), 'utf8');
    await fs.writeFile(pcPath, JSON.stringify({ provider: provider.id }), 'utf8');

    try {
      await fn({ tmp, benchmarkConfigPath: bcPath, providerConfigPath: pcPath });
    } finally {
      registry.benchmarks.delete(benchmark.id);
      registry.providers.delete(provider.id);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test('executeRun materializes provider artifacts to <outDir>/<artifact.path>', async () => {
  await withFixture(async ({ tmp, benchmarkConfigPath, providerConfigPath }) => {
    const outDir = path.join(tmp, 'run');
    await executeRun({
      repoRoot: process.cwd(),
      outDir,
      benchmarkConfigPath: path.relative(process.cwd(), benchmarkConfigPath),
      providerConfigPath: path.relative(process.cwd(), providerConfigPath),
      progress: false
    });
    const artifactPath = path.join(outDir, 'raw-responses', 'fake_case_1.json');
    const content = await fs.readFile(artifactPath, 'utf8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.hello, 'world');
    assert.equal(parsed.caseId, 'fake:case:1');
  });
});

test('runner rejects artifact paths containing .. (no path traversal)', async () => {
  // Directly verify by wiring a provider that emits a malicious path.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-artifacts-'));
  try {
    const benchmark = {
      id: 'traversal-bench',
      version: 'v1',
      materializationVersion: 'v1',
      async loadCases() {
        return {
          benchmark: {
            id: this.id, version: this.version, sourceRoot: tmp,
            sourceFiles: [], materializationVersion: 'v1', queryTransformId: null
          },
          inventory: { benchmark: this.id, records: [], summary: {} },
          cases: [{
            caseId: 'c', benchmarkId: this.id, prompt: 'q', split: 'test',
            metadata: {
              datasetName: 'd', datasetIndex: 0, doc_type: 'case', field: 'q',
              model_type: 'case_question', state: 'MI',
              expected: { kind: 'exact', canonical_citation: '1 X 1', alternates: [] }
            }
          }]
        };
      }
    };
    const provider = {
      id: 'traversal-provider', version: 'v1',
      async describe() { return { id: this.id, version: 'v1', target: 'x' }; },
      async executeCase({ benchmarkCase }) {
        return {
          caseId: benchmarkCase.caseId, status: 'completed',
          rawOutput: { httpStatus: 200 },
          finalOutputText: JSON.stringify({ query: 'q', results: [{ rank: 1, citation: '1 X 1', citations: ['1 X 1'] }], result_count: 1, total_available: 1 }),
          artifacts: [{ path: '../ESCAPED.json', content: 'nope' }],
          providerMetadata: { httpStatus: 200 },
          timing: { startedAt: null, completedAt: null, durationMs: 10 },
          error: null
        };
      }
    };
    registry.benchmarks.set(benchmark.id, benchmark);
    registry.providers.set(provider.id, provider);
    const bcPath = path.join(tmp, 'b.json');
    const pcPath = path.join(tmp, 'p.json');
    await fs.writeFile(bcPath, JSON.stringify({ benchmarkId: benchmark.id }), 'utf8');
    await fs.writeFile(pcPath, JSON.stringify({ provider: provider.id }), 'utf8');
    try {
      const outDir = path.join(tmp, 'run');
      await executeRun({
        repoRoot: process.cwd(),
        outDir,
        benchmarkConfigPath: path.relative(process.cwd(), bcPath),
        providerConfigPath: path.relative(process.cwd(), pcPath),
        progress: false
      });
      // The escaped file must NOT exist alongside the tmp dir.
      const escaped = path.resolve(outDir, '..', 'ESCAPED.json');
      assert.equal(
        await fs.stat(escaped).then(() => true, () => false),
        false,
        'traversal artifact should have been skipped'
      );
    } finally {
      registry.benchmarks.delete(benchmark.id);
      registry.providers.delete(provider.id);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
