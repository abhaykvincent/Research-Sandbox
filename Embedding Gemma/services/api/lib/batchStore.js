import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

const batchFile = join(dataDir, 'batch-jobs.json');
const cacheFile = join(dataDir, 'embedding-cache.json');

// Sweep tmp files orphaned by a kill between write and atomic rename.
for (const f of [batchFile, cacheFile]) {
  try {
    for (const entry of readdirSync(dataDir)) {
      if (entry.startsWith(`${basename(f)}.tmp.`)) {
        try { unlinkSync(join(dataDir, entry)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}
// Bound persisted history so batch-jobs.json can't grow to tens of MB
// (base64 buffers) and block the event loop on every synchronous write.
const MAX_STORED_BATCHES = 20;

function loadJson(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    // Live file missing (kill landed between the two renames in saveJsonAtomic
    // or first boot) — fall back to previous good copy before giving up.
    if (existsSync(path + '.bak')) return JSON.parse(readFileSync(path + '.bak', 'utf8'));
    return fallback;
  } catch {
    // Main file torn by a mid-write kill — fall back to previous good copy.
    try {
      if (existsSync(path + '.bak')) return JSON.parse(readFileSync(path + '.bak', 'utf8'));
    } catch { /* ignore */ }
    return fallback;
  }
}

// Atomic write: tmp file + rename, so a kill (nodemon restart) mid-persist
// can never leave a truncated registry. Previous good copy kept as .bak.
function saveJsonAtomic(path, obj) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj));
  try {
    if (existsSync(path)) {
      try { renameSync(path, path + '.bak'); } catch { /* ignore */ }
    }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function saveJson(path, obj) {
  saveJsonAtomic(path, obj);
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

// Prune oversized history on load (keeps newest MAX_STORED_BATCHES).
try {
  const ids = Object.values(batches)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((b) => b.batchId);
  if (ids.length > MAX_STORED_BATCHES) {
    for (const id of ids.slice(MAX_STORED_BATCHES)) delete batches[id];
  }
} catch { /* ignore */ }

let persistTimer = null;
let persistQueued = false;

function persistNow() {
  try {
    // Cap stored batches before writing.
    const ids = Object.values(batches)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((b) => b.batchId);
    for (const id of ids.slice(MAX_STORED_BATCHES)) delete batches[id];
    // Strip full vectors AND raw upload bytes before writing to disk.
    // Vectors stay in memory; bytes stay in memory only. Persisting base64
    // buffers ballooned the registry to tens of MB (2 wedding JPEGs ≈ 13MB),
    // blocking the event loop on every sync write — that OOM/crash is what
    // killed the server mid-batch. After a restart, retry/re-upload is the
    // recovery path (SHA-256 cache makes re-uploads instant); the orphaned
    // startup check fails such items fast with a clear message instead of
    // hanging the UI on polling forever.
    const slim = {};
    for (const [id, b] of Object.entries(batches)) {
      const { buffers, ...noBuf } = b;
      void buffers;
      slim[id] = { ...noBuf, buffers: {}, items: b.items.map(({ _vector, ...rest }) => rest) };
    }
    saveJson(batchFile, slim);
  } catch { /* ignore */ }
}

function persist() {
  // Debounce: progress saves (per-item) coalesce into one disk write so a
  // 14MB base64 payload doesn't block the event loop on every item.
  // Final saves call persistNow() via batchSaveNow().
  if (persistTimer) {
    persistQueued = true;
    return;
  }
  persistNow();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistQueued) {
      persistQueued = false;
      persistNow();
    }
  }, 500);
  // Don't keep the process alive for a pending persist.
  persistTimer.unref?.();
}

export function batchSave(batch) {
  batches[batch.batchId] = batch;
  persist();
}

/** Immediate write for run-start / run-done boundaries. */
export function batchSaveNow(batch) {
  batches[batch.batchId] = batch;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistQueued = false;
  }
  persistNow();
}
export function batchGet(batchId) {
  return batches[batchId] ?? null;
}
export function batchList() {
  return Object.values(batches).sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1));
}
