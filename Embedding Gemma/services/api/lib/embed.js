import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { logger } from './logger.js';

export const EMBED_MODEL = 'gemini-embedding-2';
export const MOCK_MODE = process.env.MOCK_EMBEDDINGS === '1';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Deterministic fake vector for offline testing (MOCK_EMBEDDINGS=1).
// Seeded by hash so identical files hit cache and similar names differ.
function mockVector(seedHex, dims) {
  let h = parseInt(seedHex.slice(0, 8), 16) || 1;
  const out = new Array(dims);
  for (let i = 0; i < dims; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (h / 0x7fffffff) * 2 - 1;
  }
  // L2-normalize like real embeddings
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function embedBuffer({ bytes, mimeType, outputDimensionality, fileHash }) {
  const dims = outputDimensionality ?? 768;
  const short = (fileHash || 'nohash').slice(0, 8);
  if (MOCK_MODE) {
    // Simulate latency 80–250ms so concurrency/progress is observable
    await sleep(80 + (parseInt((fileHash || '00').slice(0, 2), 16) % 170));
    if (process.env.MOCK_FAIL_ONCE && fileHash?.endsWith('0') && !globalThis.__mockRetried?.has(fileHash)) {
      globalThis.__mockRetried ??= new Set();
      globalThis.__mockRetried.add(fileHash);
      logger.warn('embed', 'mock transient failure (will retry)', { short });
      throw new Error('Mock transient failure (retry should recover)');
    }
    logger.debug('embed', 'mock vector', { short, dims });
    return { values: mockVector(fileHash || 'abcdef', dims), mocked: true };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.error('embed', 'GEMINI_API_KEY missing', { short });
    const err = new Error('GEMINI_API_KEY is not configured. See services/api/.env.example (or set MOCK_EMBEDDINGS=1 for offline tests)');
    err.status = 500;
    throw err;
  }
  const t0 = Date.now();
  logger.debug('embed', 'Gemini request start', { short, mimeType, bytes: bytes.length, dims });
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: [{ inlineData: { mimeType, data: bytes.toString('base64') } }],
      ...(outputDimensionality ? { config: { outputDimensionality } } : {}),
    });
    const values = response.embeddings?.[0]?.values ?? [];
    logger.debug('embed', 'Gemini request ok', { short, dim: values.length, ms: Date.now() - t0 });
    if (values.length === 0) logger.warn('embed', 'Gemini returned empty embedding', { short, responseKeys: Object.keys(response ?? {}) });
    return { values, mocked: false };
  } catch (err) {
    logger.warn('embed', 'Gemini request failed', { short, ms: Date.now() - t0, error: err.message, status: err.status });
    throw err;
  }
}

// Retry with exponential backoff. Returns { values, mocked, attempts } or throws.
export async function embedWithRetry(args, maxRetries = 2) {
  let attempt = 0;
  const short = (args.fileHash || 'nohash').slice(0, 8);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await embedBuffer(args);
      if (attempt > 0) logger.info('embed', 'retry recovered', { short, attempts: attempt + 1 });
      return { ...r, attempts: attempt + 1 };
    } catch (err) {
      if (attempt >= maxRetries) {
        err.attempts = attempt + 1;
        logger.error('embed', 'all attempts exhausted', { short, attempts: attempt + 1, error: err.message });
        throw err;
      }
      const backoff = 500 * 2 ** attempt;
      logger.warn('embed', `attempt ${attempt + 1} failed, backing off ${backoff}ms`, { short, error: err.message });
      await sleep(backoff);
      attempt++;
    }
  }
}
