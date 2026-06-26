import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readJsonl(file) {
  const text = await readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${error.message}`);
      }
    });
}

export async function writeJsonl(file, rows) {
  await ensureDir(path.dirname(file));
  await writeFile(
    file,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8'
  );
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  await writeFile(file, text, 'utf8');
}

export async function writeJson(file, value) {
  await writeText(file, `${canonicalStringify(value)}\n`);
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

export function canonicalStringify(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function sha256File(file) {
  return sha256Text(await readFile(file));
}

export async function listFilesRecursive(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

export function relativePath(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}
