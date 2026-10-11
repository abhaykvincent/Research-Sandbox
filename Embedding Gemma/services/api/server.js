import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { EMBED_MODEL, MOCK_MODE, embedWithRetry, sha256 } from './lib/embed.js';
import { preprocessImage, preprocessConfig, savingsPct } from './lib/image.js';
import { logger } from './lib/logger.js';
import { cacheGet, cacheSet, cacheStats, batchSave, batchSaveNow, batchGet, batchList } from './lib/batchStore.js';

const app = express();
const PORT = process.env.PORT || 5050;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Request log: method + path + size hints (helps trace UI → API issues)
app.use((req, _res, next) => {
  const len = req.headers['content-length'];
  logger.debug('http', `${req.method} ${req.path}`, len ? { contentLength: Number(len) } : undefined);
  next();
});

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
  logger.debug('health', 'ping', { mock: MOCK_MODE, cache: cacheStats(), preprocess: preprocessConfig() });
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
      logger.debug('single', 'multipart input', { name: req.file.originalname, bytes: bytes.length, mimeType });
    } else if (req.body?.imageBase64) {
      bytes = Buffer.from(req.body.imageBase64, 'base64');
      mimeType = req.body.mimeType || 'image/jpeg';
      outputDimensionality = req.body.outputDimensionality ? Number(req.body.outputDimensionality) : undefined;
      includeVector = Boolean(req.body.includeVector);
      logger.debug('single', 'JSON body input', { bytes: bytes.length, mimeType });
      if (bytes.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'Image exceeds 15 MB limit' });
    } else {
      logger.warn('single', 'no image supplied', { jobId: jobId.slice(0, 8), hasFile: Boolean(req.file), bodyKeys: Object.keys(req.body ?? {}) });
      return res.status(400).json({ error: 'Send multipart `image` file or JSON { imageBase64, mimeType }' });
    }
    if (outputDimensionality !== undefined && !(outputDimensionality >= 128 && outputDimensionality <= 3072)) {
      logger.warn('single', 'bad outputDimensionality', { jobId: jobId.slice(0, 8), outputDimensionality });
      return res.status(400).json({ error: 'outputDimensionality must be 128–3072' });
    }

    jobs.set(jobId, { jobId, status: 'processing', createdAt: new Date().toISOString() });
    logger.info('single', 'job start', {
      jobId: jobId.slice(0, 8), via: req.file ? `multipart:${req.file.originalname}` : 'json',
      bytes: bytes.length, mimeType, outputDimensionality: outputDimensionality ?? 768,
    });
    // Cost optimization: downscale + JPEG-recompress before the Gemini call.
    // Embeddings don't need full-res originals; 1024px q80 is ~5–15x smaller.
    const originalBytes = bytes.length;
    const originalMimeType = mimeType;
    const pre = await preprocessImage(bytes, mimeType, `single:${jobId.slice(0, 8)}`);
    bytes = pre.bytes;
    mimeType = pre.mimeType;
    const sentBytes = bytes.length;
    const hash = sha256(bytes);
    const dims = outputDimensionality ?? 768;
    let values, cacheHit = false, attempts = 1;
    const cached = cacheGet(hash, dims);
    if (cached) {
      values = cached.values; cacheHit = true;
      logger.info('single', 'cache HIT — skipping Gemini', { jobId: jobId.slice(0, 8), hash: hash.slice(0, 8), dims });
    } else {
      logger.debug('single', 'cache MISS — calling Gemini', { jobId: jobId.slice(0, 8), hash: hash.slice(0, 8), sentBytes, mimeType });
      const r = await embedWithRetry({ bytes, mimeType, outputDimensionality, fileHash: hash }, 2);
      values = r.values; attempts = r.attempts;
      cacheSet(hash, { values, dimension: values.length, model: EMBED_MODEL, cachedAt: new Date().toISOString() });
    }
    const processingTimeMs = Date.now() - started;
    const job = { jobId, status: 'succeeded', model: EMBED_MODEL, mimeType: originalMimeType, sizeBytes: originalBytes, sentBytes, bytesSavedPct: savingsPct(originalBytes, sentBytes), resized: pre.resized, sentWidth: pre.width, sentHeight: pre.height, dimension: values.length, outputDimensionality: outputDimensionality ?? null, processingTimeMs, cacheHit, attempts, createdAt: new Date().toISOString(), vectorPreview: values.slice(0, 12), _vector: values };
    jobs.set(jobId, job);
    const { _vector, ...pub } = job;
    logger.info('single', 'job done', { jobId: jobId.slice(0, 8), dim: values.length, ms: processingTimeMs, cacheHit, attempts, savedPct: job.bytesSavedPct });
    res.json({ ...pub, vector: includeVector ? values : undefined });
  } catch (err) {
    logger.error('single', 'job FAILED', { jobId: jobId.slice(0, 8), ms: Date.now() - started, error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
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
  logger.info('batch', 'run start', { batchId: batch.batchId.slice(0, 8), total: batch.items.length, concurrency, maxRetries });
  batch.status = 'processing';
  batch.cancelRequested = false;
  batch.updatedAt = new Date().toISOString();
  batchSaveNow(batch);

  const queue = batch.items.filter((it) => it.status === 'pending' || it.status === 'failed' || it.status === 'processing');
  logger.debug('batch', 'queue built', { batchId: batch.batchId.slice(0, 8), queued: queue.length });
  for (const it of queue) {
    if (it.status === 'failed' || it.status === 'processing') { it.status = 'pending'; it.error = null; }
  }
  batchSave(batch);

  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async (__, wIdx) => {
    logger.debug('batch', `worker ${wIdx} started`, { batchId: batch.batchId.slice(0, 8) });
    while (cursor < queue.length) {
      if (batch.cancelRequested) {
        const item = queue[cursor++];
        if (item.status === 'pending') {
          item.status = 'cancelled';
          item.processingTimeMs = 0;
        }
        continue;
      }
      const item = queue[cursor++];
      const started = Date.now();
      item.status = 'processing';
      batch.updatedAt = new Date().toISOString();
      batchSave(batch); // debounced — lets polls show processing instead of stale pending
      logger.debug('batch', 'item start', { batch: batch.batchId.slice(0, 8), file: item.fileName, idx: `${cursor}/${queue.length}` });
      try {
        const buf = batch.buffers[item.fileName];
        if (!buf) logger.warn('batch', 'buffer missing for item', { batch: batch.batchId.slice(0, 8), file: item.fileName });
        // Preprocess first so cache key + Gemini bytes are the compressed form.
        let procBytes = null;
        let procMime = item.mimeType;
        let resized = false;
        let sentWidth = null;
        let sentHeight = null;
        if (buf) {
          const pre = await preprocessImage(Buffer.from(buf, 'base64'), item.mimeType, `batch:${item.fileName}`);
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
          logger.debug('batch', 'item cache HIT', { file: item.fileName });
        } else {
          if (!procBytes) throw new Error('File bytes expired (server restarted). Re-upload to resume.');
          logger.debug('batch', 'item cache MISS — embedding', { file: item.fileName, sentBytes: procBytes.length, mime: procMime });
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
        logger.debug('batch', 'item ok', { file: item.fileName, dim: item.dimension, ms: Date.now() - started, cacheHit: item.cacheHit, attempts: item.attempts });
      } catch (err) {
        item.status = 'failed';
        item.error = err.message;
        item.attempts = err.attempts ?? maxRetries + 1;
        logger.error('batch', 'item FAILED', { file: item.fileName, ms: Date.now() - started, error: err.message });
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
  const cancelled = batch.items.filter((i) => i.status === 'cancelled').length;
  if (batch.cancelRequested || (cancelled > 0 && batch.pending === 0 && batch.failed === 0 && batch.completed + cancelled === batch.items.length)) {
    batch.status = 'cancelled';
    batch.pending = 0;
  } else {
    batch.status = batch.failed > 0 ? 'completed_with_errors' : 'succeeded';
  }
  batch.updatedAt = new Date().toISOString();
  logger.info('batch', 'run done', { batchId: batch.batchId.slice(0, 8), status: batch.status, ok: batch.completed, failed: batch.failed, cancelled });
  // Drop raw buffers once done to bound memory; cache covers future retries.
  // Keep buffers if failures remain so /retry can proceed without re-upload.
  if (batch.failed === 0) batch.buffers = {};
  batchSaveNow(batch);
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
    logger.info('batch', 'created', { batchId: batchId.slice(0, 8), total: files.length, dims: outputDimensionality, concurrency, maxRetries, names: files.map((f) => f.originalname).slice(0, 5) });
    res.status(202).json({ batchId, total: batch.total, status: 'queued' });
    runBatch(batch, { concurrency, maxRetries }).catch((err) => {
      logger.error('batch', 'run crashed', { batchId: batchId.slice(0, 8), error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
      batch.status = 'failed';
      batch.error = err.message;
      batchSave(batch);
    });
  } catch (err) {
    logger.error('batch', 'create FAILED', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/batch-jobs/:batchId', (req, res) => {
  // Prefer live in-memory copy (has processing transitions + full vectors);
  // fall back to persisted snapshot after a restart.
  const batch = batches.get(req.params.batchId) ?? batchGet(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Unknown batchId' });
  res.json(publicBatch(batch, req.query.includeVectors === 'true'));
});

/** POST /api/batch-jobs/:batchId/cancel — stop a queued/processing batch. Pending items → cancelled. */
app.post('/api/batch-jobs/:batchId/cancel', (req, res) => {
  const batch = batches.get(req.params.batchId) ?? batchGet(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Unknown batchId' });
  if (!batches.has(batch.batchId)) batches.set(batch.batchId, batch); // rehydrate after restart
  const terminal = ['succeeded', 'completed_with_errors', 'failed', 'cancelled'].includes(batch.status);
  if (terminal) return res.json({ batchId: batch.batchId, status: batch.status, cancelled: 0 });
  batch.cancelRequested = true;
  batch.status = 'cancelling';
  batch.updatedAt = new Date().toISOString();
  // If no worker is running (e.g. buffers gone after restart), finalize immediately.
  const workerAlive = batch.status === 'cancelling' && Object.keys(batch.buffers ?? {}).length === 0;
  if (workerAlive) {
    for (const it of batch.items) {
      if (it.status === 'pending' || it.status === 'processing') { it.status = 'cancelled'; it.processingTimeMs ??= 0; }
    }
    batch.pending = 0;
    batch.status = 'cancelled';
  }
  batchSaveNow(batch);
  logger.info('batch', 'cancel requested', { batchId: batch.batchId.slice(0, 8) });
  res.json({ batchId: batch.batchId, status: batch.status });
});

/** POST /api/batch-jobs/:batchId/retry — re-run failed AND stuck pending/processing items (resumable). */
app.post('/api/batch-jobs/:batchId/retry', (req, res) => {
  const batch = batches.get(req.params.batchId) ?? batchGet(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Unknown batchId' });
  if (!batches.has(batch.batchId)) batches.set(batch.batchId, batch); // rehydrate after restart
  if (batch.status === 'processing' || batch.status === 'cancelling') {
    const active = batch.items.some((i) => i.status === 'processing');
    if (active) return res.status(409).json({ error: 'Batch is already processing' });
  }
  batch.cancelRequested = false;
  const stuck = batch.items.filter((i) => i.status === 'failed' || i.status === 'pending' || i.status === 'processing').length;
  if (stuck === 0) return res.json({ batchId: batch.batchId, retried: 0, status: batch.status });
  if (Object.keys(batch.buffers ?? {}).length === 0)
    return res.status(410).json({ error: 'Original bytes expired after restart. Re-upload the shoot to resume.' });
  logger.info('batch', 'retry requested', { batchId: batch.batchId.slice(0, 8), retried: stuck });
  res.json({ batchId: batch.batchId, retried: stuck, status: 'processing' });
  runBatch(batch, { concurrency: batch.concurrency, maxRetries: batch.maxRetries }).catch((err) => {
    logger.error('batch', 'retry run crashed', { batchId: batch.batchId.slice(0, 8), error: err.message });
  });
});

// Recover in-memory registry + resume batches orphaned by a restart
// (nodemon reload wipes the fire-and-forget runBatch worker, leaving
// status=processing / items=pending forever with no worker to finish them).
for (const persisted of batchList()) {
  if (!batches.has(persisted.batchId)) batches.set(persisted.batchId, persisted);
}
for (const batch of batches.values()) {
  if (batch.cancelRequested || batch.status === 'cancelled' || batch.status === 'cancelling') {
    if (batch.status !== 'cancelled') {
      for (const it of batch.items) {
        if (it.status === 'pending' || it.status === 'processing') { it.status = 'cancelled'; it.processingTimeMs ??= 0; }
      }
      batch.pending = 0;
      batch.status = 'cancelled';
      batch.cancelRequested = false;
      batch.updatedAt = new Date().toISOString();
      batchSaveNow(batch);
    }
    continue;
  }
  const orphaned = (batch.status === 'queued' || batch.status === 'processing') &&
    batch.items.some((i) => i.status === 'pending' || i.status === 'processing');
  if (orphaned) {
    logger.warn('batch', 'resuming orphaned batch after (re)start', {
      batchId: batch.batchId.slice(0, 8),
      pending: batch.items.filter((i) => i.status !== 'succeeded' && i.status !== 'failed').length,
      hasBuffers: Object.keys(batch.buffers ?? {}).length > 0,
    });
    if (Object.keys(batch.buffers ?? {}).length === 0) {
      // Bytes are gone — fail fast so the UI stops polling forever.
      for (const it of batch.items) {
        if (it.status === 'pending' || it.status === 'processing') {
          it.status = 'failed';
          it.error = 'File bytes expired (server restarted). Re-upload to resume.';
        }
      }
      batch.completed = batch.items.filter((i) => i.status === 'succeeded').length;
      batch.failed = batch.items.filter((i) => i.status === 'failed').length;
      batch.pending = 0;
      batch.status = batch.failed > 0 ? 'completed_with_errors' : 'succeeded';
      batch.updatedAt = new Date().toISOString();
      batchSaveNow(batch);
    } else {
      runBatch(batch, { concurrency: batch.concurrency ?? 4, maxRetries: batch.maxRetries ?? 2 }).catch((err) => {
        logger.error('batch', 'resumed run crashed', { batchId: batch.batchId.slice(0, 8), error: err.message });
        batch.status = 'failed';
        batch.error = err.message;
        batchSaveNow(batch);
      });
    }
  }
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('http', 'unhandled route error', { error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
  res.status(400).json({ error: err.message });
});

process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', { reason: String(reason)?.slice(0, 500) });
});

app.listen(PORT, () => {
  logger.info('api', `listening on http://localhost:${PORT}`, { model: EMBED_MODEL, mock: MOCK_MODE, logLevel: logger.level, preprocess: preprocessConfig() });
});
