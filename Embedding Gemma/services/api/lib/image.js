import sharp from 'sharp';
import { logger } from './logger.js';

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export const PREPROCESS_ENABLED = process.env.EMBED_PREPROCESS !== '0';
export const PREPROCESS_MAX_DIM = Math.min(2048, Math.max(256, num(process.env.EMBED_MAX_DIM, 1024)));
export const PREPROCESS_QUALITY = Math.min(95, Math.max(40, num(process.env.EMBED_JPEG_QUALITY, 80)));
// Skip recompress for files already small enough — avoids wasted CPU.
const SKIP_UNDER_BYTES = num(process.env.EMBED_SKIP_UNDER_BYTES, 350 * 1024);

export function preprocessConfig() {
  return {
    enabled: PREPROCESS_ENABLED,
    maxDim: PREPROCESS_MAX_DIM,
    quality: PREPROCESS_QUALITY,
    format: 'jpeg',
  };
}

/**
 * Downscale + JPEG-recompress an image before sending to Gemini.
 * Embeddings don't need 24MP originals — a 1024px JPEG q80 is typically
 * 5–15x smaller with negligible embedding-quality loss, directly cutting
 * upload bytes, latency, and per-request cost.
 *
 * Returns { bytes, mimeType, width, height, resized }.
 * Falls back to the original bytes on any sharp failure (e.g. HEIC without libheif).
 */
export async function preprocessImage(inputBytes, mimeType, ctx = '') {
  const originalBytes = inputBytes.length;
  const fallback = { bytes: inputBytes, mimeType, width: null, height: null, resized: false, originalBytes };
  const tag = ctx ? `preprocess:${ctx}` : 'preprocess';

  if (!PREPROCESS_ENABLED) {
    logger.debug(tag, 'skipped (EMBED_PREPROCESS=0)', { mimeType, originalBytes });
    return fallback;
  }

  try {
    const img = sharp(inputBytes, { failOn: 'none' });
    const meta = await img.metadata();
    const w = meta.width ?? null;
    const h = meta.height ?? null;
    const longest = Math.max(w ?? 0, h ?? 0);
    logger.debug(tag, 'input meta', { mimeType, originalBytes, width: w, height: h, format: meta.format });

    // Already small JPEG within dim limits → send as-is.
    if (longest > 0 && longest <= PREPROCESS_MAX_DIM && originalBytes <= SKIP_UNDER_BYTES && mimeType === 'image/jpeg') {
      logger.debug(tag, 'passthrough (already small)', { width: w, height: h, originalBytes });
      return { ...fallback, width: w, height: h };
    }

    const t0 = Date.now();
    const { data, info } = await sharp(inputBytes, { failOn: 'none' })
      .resize({ width: PREPROCESS_MAX_DIM, height: PREPROCESS_MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: PREPROCESS_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    logger.debug(tag, 'resized', {
      from: `${w}x${h}/${originalBytes}B`, to: `${info.width}x${info.height}/${data.length}B`,
      savedPct: savingsPct(originalBytes, data.length), ms: Date.now() - t0,
    });

    // Never make things worse — keep original if recompress grew the file.
    if (data.length >= originalBytes && longest <= PREPROCESS_MAX_DIM) {
      logger.debug(tag, 'recompress grew file, keeping original', { originalBytes, recompressed: data.length });
      return { ...fallback, width: w, height: h };
    }
    return { bytes: data, mimeType: 'image/jpeg', width: info.width, height: info.height, resized: true, originalBytes };
  } catch (err) {
    logger.warn(tag, 'sharp failed, using original bytes', { mimeType, originalBytes, error: err.message });
    return fallback;
  }
}

export function savingsPct(originalBytes, sentBytes) {
  if (!originalBytes || sentBytes >= originalBytes) return 0;
  return Math.round((1 - sentBytes / originalBytes) * 100);
}
