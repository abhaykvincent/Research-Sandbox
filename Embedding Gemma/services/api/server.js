import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 5050;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBED_MODEL = 'gemini-embedding-2';

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// In-memory job store for M1–M2. Firestore persistence lands in M3.
const jobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB cap for single-image tests
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG/PNG/WebP/HEIC images are accepted'));
  },
});

function getClient() {
  if (!GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not configured. See services/api/.env.example');
    err.status = 500;
    throw err;
  }
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: EMBED_MODEL, hasKey: Boolean(GEMINI_API_KEY) });
});

/**
 * POST /api/embeddings
 * Accepts: multipart form with `image` file (+ optional `outputDimensionality`),
 *          or JSON { imageBase64, mimeType, outputDimensionality, includeVector }
 * Returns: { jobId, dimension, processingTimeMs, model, ... } — full vector
 *          only when includeVector=true (to avoid shipping large vectors to UI).
 */
app.post('/api/embeddings', upload.single('image'), async (req, res) => {
  const started = Date.now();
  const jobId = randomUUID();
  try {
    let bytes;
    let mimeType;
    let outputDimensionality;
    let includeVector = false;

    if (req.file) {
      bytes = req.file.buffer;
      mimeType = req.file.mimetype;
      outputDimensionality = req.body.outputDimensionality
        ? Number(req.body.outputDimensionality)
        : undefined;
      includeVector =
        req.body.includeVector === 'true' || req.body.includeVector === true;
    } else if (req.body?.imageBase64) {
      bytes = Buffer.from(req.body.imageBase64, 'base64');
      mimeType = req.body.mimeType || 'image/jpeg';
      outputDimensionality = req.body.outputDimensionality
        ? Number(req.body.outputDimensionality)
        : undefined;
      includeVector = Boolean(req.body.includeVector);
      if (bytes.length > 15 * 1024 * 1024) {
        return res.status(413).json({ error: 'Image exceeds 15 MB limit' });
      }
    } else {
      return res.status(400).json({
        error: 'Send multipart `image` file or JSON { imageBase64, mimeType }',
      });
    }

    if (
      outputDimensionality !== undefined &&
      !(outputDimensionality >= 128 && outputDimensionality <= 3072)
    ) {
      return res
        .status(400)
        .json({ error: 'outputDimensionality must be 128–3072' });
    }

    jobs.set(jobId, { jobId, status: 'processing', createdAt: new Date().toISOString() });

    const ai = getClient();
    const base64 = bytes.toString('base64');

    const response = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: [{ inlineData: { mimeType, data: base64 } }],
      ...(outputDimensionality ? { config: { outputDimensionality } } : {}),
    });

    const values = response.embeddings?.[0]?.values ?? [];
    const processingTimeMs = Date.now() - started;

    const job = {
      jobId,
      status: 'succeeded',
      model: EMBED_MODEL,
      mimeType,
      sizeBytes: bytes.length,
      dimension: values.length,
      outputDimensionality: outputDimensionality ?? null,
      processingTimeMs,
      createdAt: new Date().toISOString(),
      vectorPreview: values.slice(0, 12),
      // Kept in memory only for M2 inspection; not returned by default.
      _vector: values,
    };
    jobs.set(jobId, job);

    const { _vector, ...publicJob } = job;
    res.json({
      ...publicJob,
      vector: includeVector ? values : undefined,
    });
  } catch (err) {
    const processingTimeMs = Date.now() - started;
    jobs.set(jobId, {
      jobId,
      status: 'failed',
      error: err.message,
      processingTimeMs,
    });
    res.status(err.status || 502).json({ jobId, error: err.message });
  }
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown jobId' });
  const includeVector = req.query.includeVector === 'true';
  const { _vector, ...publicJob } = job;
  res.json({ ...publicJob, vector: includeVector ? _vector : undefined });
});

// Multer / validation errors → JSON
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT} (model=${EMBED_MODEL})`);
});
