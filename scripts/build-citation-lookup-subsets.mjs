#!/usr/bin/env node
// Deterministic stratified subsampler for the citation-lookup datasets.
//
// Reads a full dataset (data/citation-lookup-<kind>/dataset.jsonl) and writes
// a 200-row subset (data/citation-lookup-<kind>-200/dataset.jsonl) targeting
// 100 bluebook + 100 noisy rows, sampled proportionally to the source
// authority_identifier distribution. When a tier can't supply 100 rows
// (statutes/regs have fewer than 100 bluebook rows), the deficit is filled from
// the other tier so the subset lands at exactly 200 rows.
//
// Deterministic: sampling uses a mulberry32 PRNG seeded per (kind, tier). Two
// runs produce byte-identical dataset.jsonl output. build-manifest.json
// records the source SHA and the sampled counts.
//
// Usage:
//   node scripts/build-citation-lookup-subsets.mjs
//   node scripts/build-citation-lookup-subsets.mjs --kind cases
//   node scripts/build-citation-lookup-subsets.mjs --size 200 --bluebook 100 --noisy 100
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KINDS = ['cases', 'statutes', 'regulations'];
const DEFAULT_TARGETS = { bluebook: 100, noisy: 100 };
const SEEDS = {
  cases: { bluebook: 7770, noisy: 7771 },
  statutes: { bluebook: 7772, noisy: 7773 },
  regulations: { bluebook: 7774, noisy: 7775 }
};

function parseArgs(argv) {
  const args = { kinds: [...KINDS], targets: { ...DEFAULT_TARGETS } };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--kind') {
      i += 1;
      if (!KINDS.includes(argv[i])) throw new Error(`Unknown --kind: ${argv[i]}`);
      args.kinds = [argv[i]];
    } else if (a === '--bluebook') {
      args.targets.bluebook = Number.parseInt(argv[++i], 10);
    } else if (a === '--noisy') {
      args.targets.noisy = Number.parseInt(argv[++i], 10);
    } else if (a === '--size') {
      // convenience — set bluebook+noisy to size/2 each
      const size = Number.parseInt(argv[++i], 10);
      args.targets.bluebook = Math.floor(size / 2);
      args.targets.noisy = Math.ceil(size / 2);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(array, rng) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Deterministic sorted-keys JSON — matches the Python builder + enrichment
// script so file diffs are minimal.
function sortedStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(sortedStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + sortedStringify(value[k])).join(',') + '}';
}

async function writeJsonlAtomic(file, rows) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = rows.map(sortedStringify).join('\n') + '\n';
  try {
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function sha256File(file) {
  const buf = await fs.readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

// Stratified sample: proportional per-authority target counts (largest
// remainder for rounding drift), then random pick within each authority
// bucket. If a bucket's rows < its target, we take all of them and let
// callers redistribute the deficit at the caller layer.
function stratifiedSample(rows, target, seed) {
  const rng = mulberry32(seed);
  if (rows.length <= target) return shuffleInPlace([...rows], rng);
  const buckets = new Map();
  for (const row of rows) {
    const key = row.expected?.authority_identifier ?? '<unknown>';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const totalN = rows.length;
  const bucketEntries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  const raw = bucketEntries.map(([key, bucket]) => {
    const exact = (bucket.length / totalN) * target;
    return { key, bucket, exact, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let allocated = raw.reduce((s, r) => s + r.floor, 0);
  const deficit = target - allocated;
  raw.sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key));
  for (let i = 0; i < deficit; i += 1) raw[i].floor += 1;
  const picked = [];
  for (const { bucket, floor } of raw) {
    if (floor <= 0) continue;
    const take = Math.min(floor, bucket.length);
    shuffleInPlace([...bucket], rng); // burn some rng entropy for reproducibility
    const shuffled = [...bucket];
    shuffleInPlace(shuffled, rng);
    picked.push(...shuffled.slice(0, take));
  }
  return shuffleInPlace(picked, rng);
}

function updateCaseId(row, tier, index) {
  const oldId = row.caseId ?? row.case_id ?? `row-${index}`;
  return { ...row, caseId: `${oldId}#subset-200-${tier}-${String(index).padStart(3, '0')}` };
}

async function buildSubsetForKind(kind, targets) {
  const srcDir = path.join(REPO_ROOT, 'data', `citation-lookup-${kind}`);
  const srcFile = path.join(srcDir, 'dataset.jsonl');
  const dstDir = path.join(REPO_ROOT, 'data', `citation-lookup-${kind}-200`);
  const dstFile = path.join(dstDir, 'dataset.jsonl');
  const manifestFile = path.join(dstDir, 'build-manifest.json');

  const rows = await readJsonl(srcFile);
  const bluebook = rows.filter((r) => r?.expected?.difficulty === 'bluebook');
  const noisy = rows.filter((r) => r?.expected?.difficulty === 'noisy');

  const bluebookTarget = Math.min(targets.bluebook, bluebook.length);
  const noisyTarget = Math.min(targets.noisy, noisy.length);
  const shortfall = (targets.bluebook - bluebookTarget) + (targets.noisy - noisyTarget);
  const finalTargets = { bluebook: bluebookTarget, noisy: noisyTarget };
  // Backfill from whichever tier still has headroom (typically noisy).
  if (shortfall > 0) {
    const remainingNoisy = noisy.length - noisyTarget;
    const remainingBluebook = bluebook.length - bluebookTarget;
    let deficit = shortfall;
    if (remainingNoisy > 0) {
      const bump = Math.min(deficit, remainingNoisy);
      finalTargets.noisy += bump;
      deficit -= bump;
    }
    if (deficit > 0 && remainingBluebook > 0) {
      const bump = Math.min(deficit, remainingBluebook);
      finalTargets.bluebook += bump;
      deficit -= bump;
    }
  }

  const seeds = SEEDS[kind];
  const bluebookSampled = stratifiedSample(bluebook, finalTargets.bluebook, seeds.bluebook).map((r, i) =>
    updateCaseId(r, 'bluebook', i)
  );
  const noisySampled = stratifiedSample(noisy, finalTargets.noisy, seeds.noisy).map((r, i) =>
    updateCaseId(r, 'noisy', i)
  );
  const combined = [...bluebookSampled, ...noisySampled];
  // Final ordering: bluebook first, noisy second — stable + deterministic.
  await writeJsonlAtomic(dstFile, combined);

  const srcSha = await sha256File(srcFile);
  const manifest = {
    kind,
    subset_size: combined.length,
    source_dataset: path.relative(REPO_ROOT, srcFile),
    source_dataset_sha256: srcSha,
    tier_counts: {
      bluebook_available: bluebook.length,
      noisy_available: noisy.length,
      bluebook_sampled: bluebookSampled.length,
      noisy_sampled: noisySampled.length
    },
    seeds,
    sampling: 'stratified-by-authority_identifier, largest-remainder rounding, mulberry32 shuffle',
    generated_at: new Date().toISOString()
  };
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  process.stdout.write(
    `${kind}: wrote ${combined.length} rows (${bluebookSampled.length} bluebook + ${noisySampled.length} noisy)\n`
  );
  process.stdout.write(`  ${path.relative(REPO_ROOT, dstFile)}\n`);
  process.stdout.write(`  ${path.relative(REPO_ROOT, manifestFile)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const kind of args.kinds) {
    await buildSubsetForKind(kind, args.targets);
  }
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? '');

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}

export const _internals = {
  mulberry32,
  stratifiedSample,
  sortedStringify,
  DEFAULT_TARGETS,
  SEEDS
};
