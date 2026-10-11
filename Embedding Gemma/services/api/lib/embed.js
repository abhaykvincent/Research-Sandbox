import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

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
  if (MOCK_MODE) {
    // Simulate latency 80–250ms so concurrency/progress is observable
    await sleep(80 + (parseInt((fileHash || '00').slice(0, 2), 16) % 170));
    if (process.env.MOCK_FAIL_ONCE && fileHash?.endsWith('0') && !globalThis.__mockRetried?.has(fileHash)) {
      globalThis.__mockRetried ??= new Set();
      globalThis.__mockRetried.add(fileHash);
      throw new Error('Mock transient failure (retry should recover)');
    }
    return { values: mockVector(fileHash || 'abcdef', dims), mocked: true };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured. See services/api/.env.example (or set MOCK_EMBEDDINGS=1 for offline tests)');
    err.status = 500;
    throw err;
  }
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: [{ inlineData: { mimeType, data: bytes.toString('base64') } }],
    ...(outputDimensionality ? { config: { outputDimensionality } } : {}),
  });
  return { values: response.embeddings?.[0]?.values ?? [], mocked: false };
}

// Retry with exponential backoff. Returns { values, mocked, attempts } or throws.
export async function embedWithRetry(args, maxRetries = 2) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await embedBuffer(args);
      return { ...r, attempts: attempt + 1 };
    } catch (err) {
      if (attempt >= maxRetries) {
        err.attempts = attempt + 1;
        throw err;
      }
      await sleep(500 * 2 ** attempt);
      attempt++;
    }
  }
}
