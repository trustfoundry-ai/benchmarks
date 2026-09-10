import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { listSuites, parseTargetRef, resolveTarget } from '../src/core/suites.mjs';

// These tests build their own fixture manifests under a temp directory
// rather than asserting against `suites/` in this repo: suite manifests
// are data this package's own tests must not depend on, and the fixtures
// below stay meaningful whatever suites happen to be registered for real.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(
  packageRoot,
  'src/core/contracts/suite-manifest.schema.json'
);

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
