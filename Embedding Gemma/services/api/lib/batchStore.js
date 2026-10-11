import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

const batchFile = join(dataDir, 'batch-jobs.json');
const cacheFile = join(dataDir, 'embedding-cache.json');

function loadJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

// ---- Embedding cache: sha256 -> { values, dims, model, cachedAt } ----
let cache = loadJson(cacheFile, {});
export function cacheGet(hash, dims) {
  const entry = cache[hash];
  if (entry && (!dims || entry.dimension === dims)) return entry;
  return null;
}
export function cacheSet(hash, record) {
  cache[hash] = record;
  // Best-effort persist; cap at 2000 entries to bound file size
  const keys = Object.keys(cache);
  if (keys.length > 2000) delete cache[keys[0]];
  try { saveJson(cacheFile, cache); } catch { /* ignore */ }
}
export function cacheStats() {
  return { entries: Object.keys(cache).length };
}

// ---- Batch job persistence (metadata + previews, not full vectors) ----
let batches = loadJson(batchFile, {});

function persist() {
  try {
    // Strip full vectors before writing to disk (vectors stay in memory;
    // re-fetch with ?includeVectors=true only while server runs; cache covers resume)
    const slim = {};
    for (const [id, b] of Object.entries(batches)) {
      slim[id] = { ...b, items: b.items.map(({ _vector, ...rest }) => rest) };
    }
    saveJson(batchFile, slim);
  } catch { /* ignore */ }
}

export function batchSave(batch) {
  batches[batch.batchId] = batch;
  persist();
}
export function batchGet(batchId) {
  return batches[batchId] ?? null;
}
export function batchList() {
  return Object.values(batches).sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1));
}
