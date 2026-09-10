import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { listSuites, parseTargetRef, resolveTarget } from '../src/core/suites.mjs';
import { exists } from '../src/core/fs.mjs';
import { getScorerAdapter } from '../src/core/registry.mjs';
import { scorerAdapterId } from '../src/core/runner.mjs';

// These tests build their own fixture manifests under a temp directory
// rather than asserting against `suites/` in this repo: suite manifests
// are data this package's own tests must not depend on, and the fixtures
// below stay meaningful whatever suites happen to be registered for real.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(
  packageRoot,
  'src/core/contracts/suite-manifest.schema.json'
);

// The repo's own suites/ and configs/benchmarks/ trees, used only by the
// tests below that deliberately assert against real, committed content
// (as opposed to every other test in this file, which builds fixtures).
const repoRoot = packageRoot;

async function withTempDir(runner) {
  const dir = await mkdtemp(path.join(tmpdir(), 'suites-test-'));
  try {
    await runner(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function validManifest(overrides = {}) {
  return {
    id: 'trustfoundry-demo-suite',
    title: 'Demo suite',
    status: 'experimental',
    targets: {
      'demo-50': {
        benchmark: 'configs/benchmarks/demo-suite/demo-50.json',
        provider: 'configs/providers/demo.json',
        scorer: 'configs/scorers/demo.json',
        rows: 50
      }
    },
    ...overrides
  };
}

async function writeManifest(root, id, manifest) {
  const dir = path.join(root, 'suites', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'suite.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

async function touchTargetPaths(root, target) {
  for (const key of ['benchmark', 'provider', 'scorer']) {
    const full = path.join(root, target[key]);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, '{}\n', 'utf8');
  }
}

// ---- parseTargetRef ----

test('parseTargetRef splits a <suite>/<target> reference', () => {
  assert.deepEqual(parseTargetRef('trustfoundry-legal-search/laws-5k'), {
    suiteId: 'trustfoundry-legal-search',
    targetId: 'laws-5k'
  });
});

test('parseTargetRef rejects a reference without a target', () => {
  assert.throws(() => parseTargetRef('trustfoundry-legal-search'), /expected <suite>\/<target>/);
});

test('parseTargetRef rejects a reference with too many segments', () => {
  assert.throws(() => parseTargetRef('a/b/c'), /expected <suite>\/<target>/);
});

test('parseTargetRef rejects an empty suite half', () => {
  assert.throws(() => parseTargetRef('/laws-5k'), /expected <suite>\/<target>/);
});

test('parseTargetRef rejects an empty target half', () => {
  assert.throws(() => parseTargetRef('trustfoundry-legal-search/'), /expected <suite>\/<target>/);
});

test('parseTargetRef rejects a non-string ref', () => {
  assert.throws(() => parseTargetRef(undefined), /expected <suite>\/<target>/);
});

// ---- listSuites ----

test('listSuites returns [] when there is no suites directory', async () => {
  await withTempDir(async (repoRoot) => {
    assert.deepEqual(await listSuites({ repoRoot }), []);
  });
});

test('listSuites skips a suite directory with no suite.json', async () => {
  await withTempDir(async (repoRoot) => {
    await mkdir(path.join(repoRoot, 'suites', 'trustfoundry-stub-suite'), { recursive: true });
    await writeFile(
      path.join(repoRoot, 'suites', 'trustfoundry-stub-suite', 'README.md'),
      '# stub\n'
    );
    assert.deepEqual(await listSuites({ repoRoot }), []);
  });
});

test('listSuites returns every committed suite manifest, sorted by id', async () => {
  await withTempDir(async (repoRoot) => {
    await writeManifest(repoRoot, 'trustfoundry-alpha-suite', validManifest({ id: 'trustfoundry-alpha-suite' }));
    await writeManifest(repoRoot, 'trustfoundry-beta-suite', validManifest({ id: 'trustfoundry-beta-suite' }));
    const ids = (await listSuites({ repoRoot })).map((s) => s.id);
    assert.deepEqual(ids, ['trustfoundry-alpha-suite', 'trustfoundry-beta-suite']);
  });
});

test('listSuites reports the suite dir and target config triple', async () => {
  await withTempDir(async (repoRoot) => {
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', validManifest());
    const [suite] = await listSuites({ repoRoot });
    assert.equal(suite.dir, 'suites/trustfoundry-demo-suite');
    assert.equal(suite.title, 'Demo suite');
    assert.equal(suite.status, 'experimental');
    assert.equal(suite.targets['demo-50'].benchmark, 'configs/benchmarks/demo-suite/demo-50.json');
    assert.equal(suite.targets['demo-50'].rows, 50);
  });
});

test('listSuites synthesizes a bundle field equal to the target id', async () => {
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    manifest.targets['another-target'] = {
      benchmark: 'configs/benchmarks/demo-suite/another.json',
      provider: 'configs/providers/demo.json',
      scorer: 'configs/scorers/demo.json',
      rows: 10
    };
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    const [suite] = await listSuites({ repoRoot });
    assert.equal(suite.targets['demo-50'].bundle, 'demo-50');
    assert.equal(suite.targets['another-target'].bundle, 'another-target');
  });
});

test('listSuites rejects a manifest that tries to author a bundle key', async () => {
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    manifest.targets['demo-50'].bundle = 'demo-50';
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    await assert.rejects(listSuites({ repoRoot }), /unknown key 'bundle'/);
  });
});

test('listSuites throws a clear error for invalid JSON in suite.json', async () => {
  await withTempDir(async (repoRoot) => {
    const dir = path.join(repoRoot, 'suites', 'trustfoundry-broken-suite');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'suite.json'), '{ not valid json', 'utf8');
    await assert.rejects(
      listSuites({ repoRoot }),
      /suites\/trustfoundry-broken-suite\/suite\.json: invalid JSON/
    );
  });
});

test('listSuites throws when a suite id does not match its directory', async () => {
  await withTempDir(async (repoRoot) => {
    await writeManifest(
      repoRoot,
      'trustfoundry-actual-dir',
      validManifest({ id: 'trustfoundry-declared-id' })
    );
    await assert.rejects(listSuites({ repoRoot }), /does not match its directory/);
  });
});

test('listSuites throws when status is not a recognized value', async () => {
  await withTempDir(async (repoRoot) => {
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', validManifest({ status: 'wip' }));
    await assert.rejects(listSuites({ repoRoot }), /status must be one of/);
  });
});

test('listSuites throws on an unknown top-level key', async () => {
  await withTempDir(async (repoRoot) => {
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', validManifest({ owner: 'nobody' }));
    await assert.rejects(listSuites({ repoRoot }), /unknown key 'owner'/);
  });
});

test('listSuites throws on an unknown target key', async () => {
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    manifest.targets['demo-50'].extra = true;
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    await assert.rejects(listSuites({ repoRoot }), /unknown key 'extra'/);
  });
});

test('listSuites throws when targets is empty', async () => {
  await withTempDir(async (repoRoot) => {
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', validManifest({ targets: {} }));
    await assert.rejects(listSuites({ repoRoot }), /at least one target/);
  });
});

// ---- resolveTarget ----

test('resolveTarget returns the config triple for a target', async () => {
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    await touchTargetPaths(repoRoot, manifest.targets['demo-50']);
    const { suite, targetId, target } = await resolveTarget({
      repoRoot,
      suiteId: 'trustfoundry-demo-suite',
      targetId: 'demo-50'
    });
    assert.equal(suite.id, 'trustfoundry-demo-suite');
    assert.equal(targetId, 'demo-50');
    assert.equal(target.benchmark, 'configs/benchmarks/demo-suite/demo-50.json');
    assert.equal(target.rows, 50);
    assert.equal(target.bundle, 'demo-50');
  });
});

test('resolveTarget names the valid targets when the target is unknown', async () => {
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    await touchTargetPaths(repoRoot, manifest.targets['demo-50']);
    await assert.rejects(
      resolveTarget({ repoRoot, suiteId: 'trustfoundry-demo-suite', targetId: 'nope' }),
      /Unknown target 'nope' for suite 'trustfoundry-demo-suite'\. Valid targets: demo-50/
    );
  });
});

test('resolveTarget names the known suites when the suite is unknown', async () => {
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    await touchTargetPaths(repoRoot, manifest.targets['demo-50']);
    await assert.rejects(
      resolveTarget({ repoRoot, suiteId: 'nope', targetId: 'demo-50' }),
      /Unknown suite 'nope'\. Known suites: trustfoundry-demo-suite/
    );
  });
});

test('resolveTarget names the missing config path when a target file does not exist', async () => {
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    // Deliberately skip touchTargetPaths: none of benchmark/provider/scorer
    // exist on disk under this fixture root.
    await assert.rejects(
      resolveTarget({ repoRoot, suiteId: 'trustfoundry-demo-suite', targetId: 'demo-50' }),
      /'benchmark' config path does not exist — configs\/benchmarks\/demo-suite\/demo-50\.json/
    );
  });
});

// ---- schema <-> loader drift ----
//
// suite-manifest.schema.json is documentation only: nothing loads a JSON
// Schema validator against it (this package ships zero runtime
// dependencies on purpose). The `required` lists below are read back from
// the committed schema file itself, not retyped here, so if a required
// field is added to the schema without the loader being taught to enforce
// it — or the loader starts requiring something the schema doesn't — one
// of these two tests catches the mismatch.

async function readSchema() {
  return JSON.parse(await readFile(schemaPath, 'utf8'));
}

test('every schema-required suite field is enforced by the loader', async () => {
  const schema = await readSchema();
  for (const field of schema.required) {
    await withTempDir(async (repoRoot) => {
      const manifest = validManifest();
      delete manifest[field];
      await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
      await assert.rejects(
        listSuites({ repoRoot }),
        new RegExp(`missing required key '${field}'`),
        `schema requires '${field}' but the loader accepted a manifest missing it`
      );
    });
  }
});

test('every schema-required target field is enforced by the loader', async () => {
  const schema = await readSchema();
  const targetRequired = schema.properties.targets.additionalProperties.required;
  for (const field of targetRequired) {
    await withTempDir(async (repoRoot) => {
      const manifest = validManifest();
      delete manifest.targets['demo-50'][field];
      await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
      await assert.rejects(
        listSuites({ repoRoot }),
        new RegExp(`missing required key '${field}'`),
        `schema requires target field '${field}' but the loader accepted a manifest missing it`
      );
    });
  }
});

test('a manifest with exactly the schema-required fields is accepted', async () => {
  // The mirror check: the loader must not reject anything the schema
  // doesn't itself mark required, or the two artifacts have drifted the
  // other way — the doc promises less than the code actually demands.
  const schema = await readSchema();
  const targetRequired = schema.properties.targets.additionalProperties.required;
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    const target = manifest.targets['demo-50'];
    for (const key of Object.keys(target)) {
      if (!targetRequired.includes(key)) delete target[key];
    }
    for (const key of Object.keys(manifest)) {
      if (!schema.required.includes(key)) delete manifest[key];
    }
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    await touchTargetPaths(repoRoot, target);
    const suites = await listSuites({ repoRoot });
    assert.equal(suites.length, 1);
  });
});

test('every path a fixture suite manifest names exists once touched', async () => {
  // Not a repo-content assertion — a regression guard on resolveTarget's
  // own path check, exercised through the public entry point.
  await withTempDir(async (repoRoot) => {
    const manifest = validManifest();
    await writeManifest(repoRoot, 'trustfoundry-demo-suite', manifest);
    await touchTargetPaths(repoRoot, manifest.targets['demo-50']);
    const { access } = await import('node:fs/promises');
    for (const key of ['benchmark', 'provider', 'scorer']) {
      await access(path.join(repoRoot, manifest.targets['demo-50'][key]));
    }
    await resolveTarget({ repoRoot, suiteId: 'trustfoundry-demo-suite', targetId: 'demo-50' });
  });
});

// ---- real suite manifests ----
//
// Unlike every test above, these two assert against this repo's actual
// suites/ and configs/benchmarks/ trees on purpose: their whole job is
// inventory consistency between the two, which a fixture can't stand in for.

test('listSuites against the real repo root returns both suites with their expected target ids', async () => {
  const suites = await listSuites({ repoRoot });
  const byId = Object.fromEntries(suites.map((suite) => [suite.id, suite]));

  assert.deepEqual(
    Object.keys(byId['trustfoundry-legal-search'].targets).sort(),
    [
      'case-questions-200',
      'case-questions-5k',
      'key-facts-200',
      'key-facts-5k',
      'laws-200',
      'laws-5k',
      'regs-200',
      'regs-5k'
    ]
  );
  assert.deepEqual(
    Object.keys(byId['trustfoundry-case-name-lookup'].targets).sort(),
    ['negatives-50', 'public-1050', 'public-8850']
  );
});

test('resolveTarget succeeds for every real target in every real suite', async () => {
  // listSuites does no filesystem existence check on a target's benchmark/
  // provider/scorer paths — only resolveTarget does. The orphan-config test
  // below happens to catch a bad `benchmark` path indirectly (it cross-checks
  // against configs/benchmarks/ contents), but nothing plays that role for
  // `provider` or `scorer`. Looping every real target through resolveTarget
  // is what actually proves all thirty paths resolve, and it is derived from
  // listSuites rather than hardcoded, so a target added later is covered
  // automatically.
  const suites = await listSuites({ repoRoot });
  for (const suite of suites) {
    for (const targetId of Object.keys(suite.targets)) {
      await resolveTarget({ repoRoot, suiteId: suite.id, targetId });
    }
  }
});

test('every real target resolves to a registered scorer adapter', async () => {
  // The test above proves a target's three config paths exist. It does not
  // prove the runner can decide WHICH scorer adapter to run, because that id
  // lives in the configs' contents rather than in their paths: `scorerAdapterId`
  // reads the benchmark config's `scorer` first and the scorer config's `id`
  // last, and there is no shipped default. A suite whose configs set neither
  // therefore passes every path-level check and throws only once a run is
  // already under way, after provider calls have been spent. Calling the
  // runner's own resolver keeps this assertion from drifting away from that
  // precedence, and looking the result up in the registry means a typo'd or
  // unregistered id fails here too.
  const suites = await listSuites({ repoRoot });
  for (const suite of suites) {
    for (const [targetId, target] of Object.entries(suite.targets)) {
      const benchmarkConfig = JSON.parse(
        await readFile(path.join(repoRoot, target.benchmark), 'utf8')
      );
      const scorerConfig = JSON.parse(
        await readFile(path.join(repoRoot, target.scorer), 'utf8')
      );
      const id = scorerAdapterId(benchmarkConfig, scorerConfig);
      assert.ok(
        getScorerAdapter(id),
        `${suite.id}/${targetId} names scorer '${id}', which is not registered`
      );
    }
  }
});

test('every benchmark config is claimed by exactly one suite target', async () => {
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const suites = await listSuites({ repoRoot });

  const claimed = new Map();
  for (const suite of suites) {
    for (const [targetId, target] of Object.entries(suite.targets)) {
      const prior = claimed.get(target.benchmark);
      assert.equal(
        prior,
        undefined,
        `${target.benchmark} claimed by both ${prior} and ${suite.id}/${targetId}`
      );
      claimed.set(target.benchmark, `${suite.id}/${targetId}`);
    }
  }

  // Vendor adapter examples are deliberately unclaimed; they are not suites.
  const VENDOR_EXAMPLES = [
    'anthropic-legal-search',
    'exa-legal-search-aggregators-only',
    'openai-legal-search',
    'parallel-legal-search-aggregators-only',
    'parallel-legal-search-primary-only'
  ];

  const benchRoot = path.join(repoRoot, 'configs', 'benchmarks');
  for (const dir of await readdir(benchRoot)) {
    if (VENDOR_EXAMPLES.includes(dir)) continue;
    for (const file of await readdir(path.join(benchRoot, dir))) {
      if (!file.endsWith('.json')) continue;
      const rel = `configs/benchmarks/${dir}/${file}`;
      assert.ok(
        claimed.has(rel),
        `${rel} is not claimed by any suite target. Either add it to a suite ` +
          'manifest as a target, or, if it is an adapter example rather than a ' +
          "suite, add its directory to this test's VENDOR_EXAMPLES allowlist."
      );
    }
  }
});

/**
 * Scans `results/<suite>/<date>/<target>/` on disk and returns the set of
 * target ids that have at least one dated bundle directory checked in.
 * Reads real filesystem state, independent of anything the pointer claims.
 */
async function findBundledTargetIds(root, suiteId) {
  const suiteResultsDir = path.join(root, 'results', suiteId);
  const found = new Set();
  if (!(await exists(suiteResultsDir))) return found;
  for (const dateEntry of await readdir(suiteResultsDir, { withFileTypes: true })) {
    if (!dateEntry.isDirectory()) continue;
    const dateDir = path.join(suiteResultsDir, dateEntry.name);
    for (const targetEntry of await readdir(dateDir, { withFileTypes: true })) {
      if (targetEntry.isDirectory()) found.add(targetEntry.name);
    }
  }
  return found;
}

/**
 * Checks one suite's `results/<suite>/latest.json` pointer against its
 * declared targets and the bundle directories actually checked in under
 * `results/<suite>/`. Three independent invariants, each guarding a
 * different failure:
 *
 * 1. No orphan pointer entries. Every key the pointer names must be a
 *    target id the suite manifest actually declares, and its value must
 *    resolve to a path ending in that same target id. Applies to every
 *    suite regardless of status — a pointer naming a target the manifest
 *    doesn't know about is a stale or mistyped entry no matter how far
 *    along the suite is.
 * 2. No orphan bundles. Every target that has a dated bundle directory on
 *    disk must have a pointer entry naming it. Applies to every suite
 *    regardless of status. This is what catches a pointer entry lost to a
 *    bad merge or a hand edit while the bundle it pointed at is still
 *    sitting there on disk, unreachable through `latest.json`.
 * 3. Full-tier coverage. A `published` suite's `tier: full` targets carry
 *    its load-bearing claims, so each one must be backed by a real,
 *    pointed-to bundle — not merely declared in the manifest. A `tier:
 *    smoke` target makes no such claim and may be declared with nothing
 *    published for it yet, so it is exempt from this rule alone (rules 1
 *    and 2 still apply to it once it has either a pointer entry or a
 *    bundle on disk).
 */
async function checkPointerConsistency({ repoRoot: root, suite }) {
  const pointerPath = path.join(root, 'results', suite.id, 'latest.json');
  const targetIds = Object.keys(suite.targets).sort();
  const pointerIsPresent = await exists(pointerPath);
  const pointer = pointerIsPresent ? JSON.parse(await readFile(pointerPath, 'utf8')) : {};
  const pointerBundles = pointer.bundles ?? {};

  // Rule 1: no orphan pointer entries.
  for (const [key, rel] of Object.entries(pointerBundles)) {
    assert.ok(
      targetIds.includes(key),
      `${suite.id}/latest.json '${key}' is not a target declared in suites/${suite.id}/suite.json`
    );
    assert.ok(
      rel.endsWith(`/${key}`),
      `${suite.id}/latest.json '${key}' -> '${rel}' must end with the target id`
    );
  }

  // Rule 2: no orphan bundles -- a bundle directory on disk with no pointer
  // entry naming it.
  const bundledTargetIds = await findBundledTargetIds(root, suite.id);
  for (const targetId of bundledTargetIds) {
    if (!targetIds.includes(targetId)) continue; // not this rule's job -- see rule 1 / orphan-config
    assert.ok(
      targetId in pointerBundles,
      `results/${suite.id}/ has a bundle directory for '${targetId}' but ` +
        `results/${suite.id}/latest.json has no pointer entry for it`
    );
  }

  if (suite.status !== 'published') return;

  // Rule 3: a published suite's full-tier targets must be backed by a real,
  // pointed-to bundle.
  for (const [targetId, target] of Object.entries(suite.targets)) {
    if (target.tier === 'smoke') continue;
    assert.ok(
      targetId in pointerBundles,
      `${suite.id} is published and '${targetId}' is tier:full, but ` +
        `results/${suite.id}/latest.json has no bundle for it`
    );
  }
}

test("published suites' latest.json matches declared target ids exactly; other statuses may omit or partially populate the pointer", async () => {
  for (const suite of await listSuites({ repoRoot })) {
    await checkPointerConsistency({ repoRoot, suite });
  }
});

test('an experimental suite with no pointer file at all passes pointer consistency', async () => {
  await withTempDir(async (root) => {
    const manifest = validManifest();
    await writeManifest(root, manifest.id, manifest);
    const [suite] = await listSuites({ repoRoot: root });
    await checkPointerConsistency({ repoRoot: root, suite });
  });
});

test('an experimental suite whose pointer names an undeclared target fails pointer consistency', async () => {
  await withTempDir(async (root) => {
    const manifest = validManifest();
    await writeManifest(root, manifest.id, manifest);
    const resultsDir = path.join(root, 'results', manifest.id);
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, 'latest.json'),
      JSON.stringify({ bundles: { 'not-a-declared-target': '2026-01-01/not-a-declared-target' } }),
      'utf8'
    );
    const [suite] = await listSuites({ repoRoot: root });
    await assert.rejects(
      () => checkPointerConsistency({ repoRoot: root, suite }),
      /'not-a-declared-target' is not a target declared/
    );
  });
});

test('a target with a bundle directory on disk but no pointer entry fails pointer consistency (rule 2)', async () => {
  await withTempDir(async (root) => {
    const manifest = validManifest({ status: 'experimental' });
    await writeManifest(root, manifest.id, manifest);
    // The bundle exists on disk for 'demo-50' ...
    const bundleDir = path.join(root, 'results', manifest.id, '2026-01-01', 'demo-50');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, 'result.json'), '{}\n', 'utf8');
    // ... but latest.json has no entry for it -- not even an empty pointer file.
    const [suite] = await listSuites({ repoRoot: root });
    await assert.rejects(
      () => checkPointerConsistency({ repoRoot: root, suite }),
      /has a bundle directory for 'demo-50' but .*latest\.json has no pointer entry for it/
    );
  });
});

test('a bundled, pointed-to target with a bundle directory on disk passes rule 2', async () => {
  await withTempDir(async (root) => {
    const manifest = validManifest({ status: 'experimental' });
    await writeManifest(root, manifest.id, manifest);
    const resultsDir = path.join(root, 'results', manifest.id);
    const bundleDir = path.join(resultsDir, '2026-01-01', 'demo-50');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, 'result.json'), '{}\n', 'utf8');
    await writeFile(
      path.join(resultsDir, 'latest.json'),
      JSON.stringify({ bundles: { 'demo-50': '2026-01-01/demo-50' } }),
      'utf8'
    );
    const [suite] = await listSuites({ repoRoot: root });
    await checkPointerConsistency({ repoRoot: root, suite });
  });
});

test('a published suite with a tier:full target that has no bundle fails pointer consistency (rule 3)', async () => {
  await withTempDir(async (root) => {
    const manifest = validManifest({ status: 'published' });
    manifest.targets['demo-50'].tier = 'full';
    await writeManifest(root, manifest.id, manifest);
    // No results/ directory at all for this suite -- nothing published yet.
    const [suite] = await listSuites({ repoRoot: root });
    await assert.rejects(
      () => checkPointerConsistency({ repoRoot: root, suite }),
      /is published and 'demo-50' is tier:full, but .*latest\.json has no bundle for it/
    );
  });
});

test('a published suite with only a tier:smoke target passes rule 3 with no bundle at all', async () => {
  await withTempDir(async (root) => {
    const manifest = validManifest({ status: 'published' });
    manifest.targets['demo-50'].tier = 'smoke';
    await writeManifest(root, manifest.id, manifest);
    const [suite] = await listSuites({ repoRoot: root });
    await checkPointerConsistency({ repoRoot: root, suite });
  });
});
