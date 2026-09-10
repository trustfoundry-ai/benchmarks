/**
 * Suite registry.
 *
 * A suite manifest at `suites/<id>/suite.json` is the single declaration of
 * what a suite can run. The CLI, the container entrypoint, the generated
 * README tables, and CI all resolve targets through here, so adding a suite
 * is a data change rather than an edit in four places.
 *
 * The manifest shape is documented in
 * `./contracts/suite-manifest.schema.json`, but that file is a
 * human-readable contract only — nothing in this package loads a JSON
 * Schema validator against it. The validation below is the actual
 * enforcement. `test/suites.test.mjs` reads the schema's `required` lists
 * back and asserts the loader agrees with them, so the two artifacts can't
 * silently drift apart.
 *
 * Every target returned from here carries a `bundle` field equal to its
 * own target id — the directory leaf a published result bundle is written
 * under. It is derived, not authored: no manifest declares it, and the
 * schema doesn't describe it as a property a manifest may set.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { exists, readJson } from './fs.mjs';

const SUITES_DIR = 'suites';
const MANIFEST_FILE = 'suite.json';

const SUITE_REQUIRED_KEYS = ['id', 'title', 'status', 'targets'];
const SUITE_ALLOWED_KEYS = new Set([...SUITE_REQUIRED_KEYS, '$comment']);
const STATUS_VALUES = ['experimental', 'published', 'deprecated'];
const SUITE_ID_PATTERN = /^trustfoundry-[a-z0-9-]+$/;

const TARGET_REQUIRED_KEYS = ['benchmark', 'provider', 'scorer', 'rows'];
const TARGET_ALLOWED_KEYS = new Set([...TARGET_REQUIRED_KEYS, 'headline', 'tier', '$comment']);
const TARGET_PATH_KEYS = ['benchmark', 'provider', 'scorer'];
const TIER_VALUES = ['smoke', 'full'];

/**
 * Splits a `<suite>/<target>` reference. Exactly one slash is required —
 * this is the form a researcher types on a CLI flag or in a container
 * entrypoint argument, so a missing target, a stray extra segment, and an
 * empty half are all rejected with the same clear message rather than
 * silently absorbed into one side or the other.
 */
export function parseTargetRef(ref) {
  if (typeof ref !== 'string') {
    throw new Error(
      `Invalid target reference — expected <suite>/<target>, got ${JSON.stringify(ref)}`
    );
  }
  const parts = ref.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid target reference '${ref}' — expected <suite>/<target>`);
  }
  return { suiteId: parts[0], targetId: parts[1] };
}

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function validateTarget(target, targetId, source) {
  const label = `target '${targetId}'`;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    fail(source, `${label} is not an object`);
  }
  for (const key of TARGET_REQUIRED_KEYS) {
    if (!(key in target)) fail(source, `${label} is missing required key '${key}'`);
  }
  for (const key of Object.keys(target)) {
    if (!TARGET_ALLOWED_KEYS.has(key)) fail(source, `${label} has unknown key '${key}'`);
  }
  for (const key of TARGET_PATH_KEYS) {
    if (typeof target[key] !== 'string' || !target[key]) {
      fail(source, `${label} needs a non-empty string '${key}'`);
    }
  }
  if (!Number.isInteger(target.rows) || target.rows < 1) {
    fail(source, `${label} needs an integer 'rows' >= 1, got ${JSON.stringify(target.rows)}`);
  }
  if ('headline' in target && typeof target.headline !== 'boolean') {
    fail(source, `${label} 'headline' must be a boolean`);
  }
  if ('tier' in target && !TIER_VALUES.includes(target.tier)) {
    fail(source, `${label} 'tier' must be one of ${TIER_VALUES.join(' | ')}, got '${target.tier}'`);
  }
}

function validateManifest(doc, source) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(source, 'manifest is not a JSON object');
  }
  for (const key of SUITE_REQUIRED_KEYS) {
    if (!(key in doc)) fail(source, `missing required key '${key}'`);
  }
  for (const key of Object.keys(doc)) {
    if (!SUITE_ALLOWED_KEYS.has(key)) fail(source, `unknown key '${key}'`);
  }
  if (typeof doc.id !== 'string' || !SUITE_ID_PATTERN.test(doc.id)) {
    fail(source, `id must match ${SUITE_ID_PATTERN}, got ${JSON.stringify(doc.id)}`);
  }
  if (typeof doc.title !== 'string' || !doc.title) {
    fail(source, 'title must be a non-empty string');
  }
  if (!STATUS_VALUES.includes(doc.status)) {
    fail(source, `status must be one of ${STATUS_VALUES.join(' | ')}, got '${doc.status}'`);
  }
  if (!doc.targets || typeof doc.targets !== 'object' || Array.isArray(doc.targets)) {
    fail(source, 'targets must be an object');
  }
  const targetEntries = Object.entries(doc.targets);
  if (!targetEntries.length) fail(source, 'targets must declare at least one target');
  for (const [targetId, target] of targetEntries) {
    validateTarget(target, targetId, source);
  }
}

/**
 * Attaches the runtime-only `bundle` field to each of a suite's targets:
 * the target id itself, which is also the directory leaf a published
 * result bundle is written under (`results/<suite>/<date>/<target>/`) and
 * the key a `latest.json` pointer uses. Manifests never author this field
 * — it would let a target's declared `bundle` disagree with its own key,
 * which is a defect with no upside — so `bundle` is derived here rather
 * than accepted as an authored property.
 */
function withBundleIds(targets) {
  return Object.fromEntries(
    Object.entries(targets).map(([targetId, target]) => [targetId, { ...target, bundle: targetId }])
  );
}

/**
 * Reads and validates every `suites/<id>/suite.json` manifest under
 * `repoRoot`. A suite directory with no manifest (a README-only stub for a
 * suite that isn't registered yet) is skipped rather than treated as an
 * error — it simply isn't a known suite yet.
 */
export async function listSuites({ repoRoot }) {
  const root = path.join(repoRoot, SUITES_DIR);
  if (!(await exists(root))) return [];
  const suites = [];
  for (const entry of (await readdir(root)).sort()) {
    const relDir = `${SUITES_DIR}/${entry}`;
    const source = `${relDir}/${MANIFEST_FILE}`;
    const manifestPath = path.join(repoRoot, relDir, MANIFEST_FILE);
    if (!(await exists(manifestPath))) continue;
    let doc;
    try {
      doc = await readJson(manifestPath);
    } catch (error) {
      throw new Error(`${source}: invalid JSON — ${error.message}`);
    }
    validateManifest(doc, source);
    if (doc.id !== entry) {
      fail(source, `id '${doc.id}' does not match its directory '${relDir}'`);
    }
    suites.push({
      id: doc.id,
      title: doc.title,
      status: doc.status,
      dir: relDir,
      targets: withBundleIds(doc.targets)
    });
  }
  return suites;
}

/**
 * Resolves a `{ suiteId, targetId }` pair to its suite and target, checking
 * that the target's benchmark/provider/scorer config paths actually exist
 * on disk. Throws with the list of valid ids when either id is unknown —
 * this is the first thing a researcher sees after a typo, so the message
 * names the real alternatives rather than just saying "not found".
 */
export async function resolveTarget({ repoRoot, suiteId, targetId }) {
  const suites = await listSuites({ repoRoot });
  const suite = suites.find((item) => item.id === suiteId);
  if (!suite) {
    const known = suites.map((item) => item.id).sort();
    throw new Error(`Unknown suite '${suiteId}'. Known suites: ${known.join(', ') || '(none)'}`);
  }
  const target = suite.targets[targetId];
  if (!target) {
    const validTargets = Object.keys(suite.targets).sort();
    throw new Error(
      `Unknown target '${targetId}' for suite '${suiteId}'. Valid targets: ${
        validTargets.join(', ') || '(none)'
      }`
    );
  }
  for (const key of TARGET_PATH_KEYS) {
    const full = path.join(repoRoot, target[key]);
    if (!(await exists(full))) {
      throw new Error(`${suiteId}/${targetId}: '${key}' config path does not exist — ${target[key]}`);
    }
  }
  return { suite, targetId, target };
}
