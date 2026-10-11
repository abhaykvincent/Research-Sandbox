import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { EMBED_MODEL, MOCK_MODE, embedWithRetry, sha256 } from './lib/embed.js';
import { preprocessImage, preprocessConfig, savingsPct } from './lib/image.js';
import { cacheGet, cacheSet, cacheStats, batchSave, batchGet } from './lib/batchStore.js';

const app = express();
const PORT = process.env.PORT || 5050;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// In-memory single-image jobs (M2). Batch jobs persist via batchStore (M3).
const jobs = new Map();
// In-memory batch registry mirrors persisted store; holds Buffers + full vectors at runtime.
const batches = new Map();
for (const b of []) void b;

const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG/PNG/WebP/HEIC images are accepted'));
  },
});

const uploadBatch = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Rejected ${file.originalname}: only JPEG/PNG/WebP/HEIC accepted`));
  },
});

const clamp = (n, lo, hi, dflt) => {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: EMBED_MODEL, hasKey: Boolean(process.env.GEMINI_API_KEY), mock: MOCK_MODE, cache: cacheStats(), preprocess: preprocessConfig() });
});

// ---------- M2: single image ----------
app.post('/api/embeddings', uploadSingle.single('image'), async (req, res) => {
  const started = Date.now();
  const jobId = randomUUID();
  try {
    let bytes, mimeType, outputDimensionality, includeVector = false;
    if (req.file) {
      bytes = req.file.buffer; mimeType = req.file.mimetype;
      outputDimensionality = req.body.outputDimensionality ? Number(req.body.outputDimensionality) : undefined;
      includeVector = req.body.includeVector === 'true' || req.body.includeVector === true;
    } else if (req.body?.imageBase64) {
      bytes = Buffer.from(req.body.imageBase64, 'base64');
      mimeType = req.body.mimeType || 'image/jpeg';
      outputDimensionality = req.body.outputDimensionality ? Number(req.body.outputDimensionality) : undefined;
      includeVector = Boolean(req.body.includeVector);
      if (bytes.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'Image exceeds 15 MB limit' });
    } else {
      return res.status(400).json({ error: 'Send multipart `image` file or JSON { imageBase64, mimeType }' });
    }
    if (outputDimensionality !== undefined && !(outputDimensionality >= 128 && outputDimensionality <= 3072))
      return res.status(400).json({ error: 'outputDimensionality must be 128–3072' });

    jobs.set(jobId, { jobId, status: 'processing', createdAt: new Date().toISOString() });
    // Cost optimization: downscale + JPEG-recompress before the Gemini call.
    // Embeddings don't need full-res originals; 1024px q80 is ~5–15x smaller.
    const originalBytes = bytes.length;
    const originalMimeType = mimeType;
    const pre = await preprocessImage(bytes, mimeType);
    bytes = pre.bytes;
    mimeType = pre.mimeType;
    const sentBytes = bytes.length;
    const hash = sha256(bytes);
    const dims = outputDimensionality ?? 768;
    let values, cacheHit = false, attempts = 1;
    const cached = cacheGet(hash, dims);
    if (cached) { values = cached.values; cacheHit = true; }
    else {
      const r = await embedWithRetry({ bytes, mimeType, outputDimensionality, fileHash: hash }, 2);
      values = r.values; attempts = r.attempts;
      cacheSet(hash, { values, dimension: values.length, model: EMBED_MODEL, cachedAt: new Date().toISOString() });
    }
    const processingTimeMs = Date.now() - started;
    const job = { jobId, status: 'succeeded', model: EMBED_MODEL, mimeType: originalMimeType, sizeBytes: originalBytes, sentBytes, bytesSavedPct: savingsPct(originalBytes, sentBytes), resized: pre.resized, sentWidth: pre.width, sentHeight: pre.height, dimension: values.length, outputDimensionality: outputDimensionality ?? null, processingTimeMs, cacheHit, attempts, createdAt: new Date().toISOString(), vectorPreview: values.slice(0, 12), _vector: values };
    jobs.set(jobId, job);
    const { _vector, ...pub } = job;
    res.json({ ...pub, vector: includeVector ? values : undefined });
  } catch (err) {
    jobs.set(jobId, { jobId, status: 'failed', error: err.message, processingTimeMs: Date.now() - started });
    res.status(err.status || 502).json({ jobId, error: err.message });
  }
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown jobId' });
  const { _vector, ...pub } = job;
  res.json({ ...pub, vector: req.query.includeVector === 'true' ? _vector : undefined });
});

// ---------- M3: batch jobs ----------
function publicBatch(batch, includeVectors = false) {
  return {
    ...batch,
    buffers: undefined,
    items: batch.items.map((it) => ({
      ...it,
      _vector: undefined,
      vector: includeVectors ? it._vector : undefined,
    })),
  };
}

async function runBatch(batch, { concurrency, maxRetries }) {
  batch.status = 'processing';
  batch.updatedAt = new Date().toISOString();
  batchSave(batch);

  const queue = batch.items.filter((it) => it.status === 'pending' || it.status === 'failed');
  for (const it of queue) {
    if (it.status === 'failed') { it.status = 'pending'; it.error = null; }
  }
  batchSave(batch);

  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const started = Date.now();
      item.status = 'processing';
      try {
        const buf = batch.buffers[item.fileName];
        // Preprocess first so cache key + Gemini bytes are the compressed form.
        let procBytes = null;
        let procMime = item.mimeType;
        let resized = false;
        let sentWidth = null;
        let sentHeight = null;
        if (buf) {
          const pre = await preprocessImage(Buffer.from(buf, 'base64'), item.mimeType);
          procBytes = pre.bytes;
          procMime = pre.mimeType;
          resized = pre.resized;
          sentWidth = pre.width;
          sentHeight = pre.height;
          item.originalBytes ??= item.sizeBytes;
          item.sentBytes = procBytes.length;
          item.bytesSavedPct = savingsPct(item.originalBytes, item.sentBytes);
          item.resized = resized;
          item.sha256 = sha256(procBytes);
        }
        const cached = cacheGet(item.sha256, batch.outputDimensionality);
        if (cached) {
          item._vector = cached.values;
          item.cacheHit = true;
          item.attempts = 0;
        } else {
          if (!procBytes) throw new Error('File bytes expired (server restarted). Re-upload to resume.');
          const r = await embedWithRetry(
            { bytes: procBytes, mimeType: procMime, outputDimensionality: batch.outputDimensionality, fileHash: item.sha256 },
            maxRetries,
          );
          item._vector = r.values;
          item.attempts = r.attempts;
          item.cacheHit = false;
          cacheSet(item.sha256, { values: r.values, dimension: r.values.length, model: EMBED_MODEL, cachedAt: new Date().toISOString() });
        }
        item.status = 'succeeded';
        item.dimension = item._vector.length;
        item.vectorPreview = item._vector.slice(0, 12);
      } catch (err) {
        item.status = 'failed';
        item.error = err.message;
        item.attempts = err.attempts ?? maxRetries + 1;
      }
      item.processingTimeMs = Date.now() - started;
      batch.completed = batch.items.filter((i) => i.status === 'succeeded').length;
      batch.failed = batch.items.filter((i) => i.status === 'failed').length;
      batch.pending = batch.items.length - batch.completed - batch.failed;
      batch.updatedAt = new Date().toISOString();
      batchSave(batch);
    }
  });
  await Promise.all(workers);

  batch.pending = batch.items.filter((i) => i.status === 'pending' || i.status === 'processing').length;
  batch.status = batch.failed > 0 ? 'completed_with_errors' : 'succeeded';
  batch.updatedAt = new Date().toISOString();
  // Drop raw buffers once done to bound memory; cache covers future retries.
  // Keep buffers if failures remain so /retry can proceed without re-upload.
  if (batch.failed === 0) batch.buffers = {};
  batchSave(batch);
}

/** POST /api/batch-jobs — multipart `images` (≤50), fields: outputDimensionality, concurrency, maxRetries. 202 + { batchId }. */
app.post('/api/batch-jobs', uploadBatch.array('images', 50), async (req, res) => {
  try {
    const files = req.files ?? [];
    if (files.length === 0) return res.status(400).json({ error: 'Attach 1–50 files as `images`' });
    const outputDimensionality = clamp(req.body.outputDimensionality, 128, 3072, 768);
    const concurrency = clamp(req.body.concurrency, 1, 8, 4);
    const maxRetries = clamp(req.body.maxRetries, 0, 5, 2);
    const batchId = randomUUID();
    const batch = {
      batchId, status: 'queued', model: EMBED_MODEL,
      outputDimensionality, concurrency, maxRetries,
      total: files.length, completed: 0, failed: 0, pending: files.length,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      buffers: {},
      items: files.map((f) => ({
        jobId: randomUUID(), fileName: f.originalname, mimeType: f.mimetype,
        sizeBytes: f.size, originalBytes: f.size, sentBytes: null, bytesSavedPct: null, resized: false,
        sha256: sha256(f.buffer),
        status: 'pending', dimension: null, processingTimeMs: null,
        attempts: 0, cacheHit: false, error: null, vectorPreview: null, _vector: null,
      })),
    };
    for (const f of files) {
      const h = sha256(f.buffer);
      // Keep one buffer per unique hash; duplicates share cache/bytes
      if (!batch.buffers[f.originalname]) batch.buffers[f.originalname] = f.buffer.toString('base64');
      void h;
    }
    batches.set(batchId, batch);
    batchSave(batch);
    res.status(202).json({ batchId, total: batch.total, status: 'queued' });
    runBatch(batch, { concurrency, maxRetries }).catch((err) => {
      batch.status = 'failed';
      batch.error = err.message;
      batchSave(batch);
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/batch-jobs/:batchId', (req, res) => {
  const batch = batchGet(req.params.batchId) ?? batches.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Unknown batchId' });
  res.json(publicBatch(batch, req.query.includeVectors === 'true'));
});

/** POST /api/batch-jobs/:batchId/retry — re-run failed items only (resumable). */
app.post('/api/batch-jobs/:batchId/retry', (req, res) => {
  const batch = batches.get(req.params.batchId) ?? batchGet(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Unknown batchId' });
  if (!batches.has(batch.batchId)) batches.set(batch.batchId, batch); // rehydrate after restart
  const failed = batch.items.filter((i) => i.status === 'failed').length;
  if (failed === 0) return res.json({ batchId: batch.batchId, retried: 0, status: batch.status });
  if (Object.keys(batch.buffers ?? {}).length === 0)
    return res.status(410).json({ error: 'Original bytes expired after restart. Re-upload the shoot to resume.' });
  res.json({ batchId: batch.batchId, retried: failed, status: 'processing' });
  runBatch(batch, { concurrency: batch.concurrency, maxRetries: batch.maxRetries }).catch(() => {});
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT} (model=${EMBED_MODEL}${MOCK_MODE ? ', MOCK' : ''})`);
});
