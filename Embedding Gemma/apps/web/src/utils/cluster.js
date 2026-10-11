// Milestone 5 — client-side clustering over Gemini embedding vectors.
// Cosine geometry: L2-normalize, then Euclidean k-means == cosine k-means.
// Includes k-means++ init, multi-restart, silhouette scoring, auto-k sweep,
// and classical MDS (from the cosine-distance matrix) for the 2D scatter map.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosineSimilarity(a, b) {
  if (!a?.length || a.length !== b?.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? null : dot / d;
}

export const cosineDistance = (a, b) => {
  const s = cosineSimilarity(a, b);
  return s == null ? 1 : 1 - s;
};

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function kmeansPlusPlus(normed, k, rand) {
  const n = normed.length;
  const centroids = [normed[Math.floor(rand() * n)].slice()];
  while (centroids.length < k) {
    const d2 = normed.map((v) => Math.min(...centroids.map((c) => dist2(v, c))));
    const total = d2.reduce((s, x) => s + x, 0);
    if (total === 0) {
      centroids.push(normed[Math.floor(rand() * n)].slice());
      continue;
    }
    let r = rand() * total;
    let idx = 0;
    for (; idx < n - 1; idx++) {
      r -= d2[idx];
      if (r <= 0) break;
    }
    centroids.push(normed[idx].slice());
  }
  return centroids;
}

function runOnce(normed, k, rand, maxIter = 60) {
  const n = normed.length;
  const dim = normed[0].length;
  let centroids = kmeansPlusPlus(normed, k, rand);
  let labels = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(normed[i], centroids[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }
    const next = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      const v = normed[i];
      const acc = next[labels[i]];
      for (let d = 0; d < dim; d++) acc[d] += v[d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) {
        next[c] = normed[Math.floor(rand() * n)].slice(); // rescue empty cluster
      } else {
        for (let d = 0; d < dim; d++) next[c][d] /= counts[c];
        const nn = Math.sqrt(next[c].reduce((s, x) => s + x * x, 0)) || 1;
        for (let d = 0; d < dim; d++) next[c][d] /= nn;
      }
    }
    centroids = next;
    if (!changed) break;
  }
  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += dist2(normed[i], centroids[labels[i]]);
  return { labels, centroids, inertia };
}

export function kmeans(vectors, k, { restarts = 8, seed = 42 } = {}) {
  if (!vectors?.length) throw new Error('No vectors to cluster');
  const n = vectors.length;
  if (k < 2) throw new Error('k must be ≥ 2');
  if (k > n) throw new Error(`k (${k}) exceeds photo count (${n})`);
  const dim = vectors[0].length;
  if (!vectors.every((v) => v?.length === dim)) throw new Error('Mixed vector dimensions — re-run with one dims setting');
  const normed = vectors.map(normalize);
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const cand = runOnce(normed, k, mulberry32(seed + r * 7919));
    if (!best || cand.inertia < best.inertia) best = { ...cand, restart: r };
  }
  return { ...best, normed };
}

/** Mean silhouette over cosine distance. 1 = perfect, 0 = overlapping, <0 = misassigned. */
export function silhouetteScore(vectors, labels) {
  const n = vectors.length;
  const k = Math.max(...labels) + 1;
  if (k < 2 || k >= n) return { score: null, perPoint: new Array(n).fill(null) };
  const D = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => (i === j ? 0 : cosineDistance(vectors[i], vectors[j]))),
  );
  const perPoint = new Array(n);
  for (let i = 0; i < n; i++) {
    const own = [];
    const other = new Map();
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (labels[j] === labels[i]) own.push(D[i][j]);
      else {
        if (!other.has(labels[j])) other.set(labels[j], []);
        other.get(labels[j]).push(D[i][j]);
      }
    }
    const a = own.length ? own.reduce((s, x) => s + x, 0) / own.length : 0;
    const b = other.size ? Math.min(...[...other.values()].map((arr) => arr.reduce((s, x) => s + x, 0) / arr.length)) : 0;
    perPoint[i] = own.length && other.size ? (b - a) / Math.max(a, b) : null;
  }
  const valid = perPoint.filter((v) => v != null);
  return { score: valid.length ? valid.reduce((s, x) => s + x, 0) / valid.length : null, perPoint };
}

export function sweepK(vectors, kMin = 2, kMax = 6, opts = {}) {
  const n = vectors.length;
  const hi = Math.min(kMax, n - 1);
  const rows = [];
  for (let k = kMin; k <= hi; k++) {
    const r = kmeans(vectors, k, opts);
    const s = silhouetteScore(vectors, r.labels);
    rows.push({ k, silhouette: s.score, inertia: r.inertia });
  }
  const ranked = rows.filter((r) => r.silhouette != null).sort((a, b) => b.silhouette - a.silhouette);
  return { rows, bestK: ranked.length ? ranked[0].k : null };
}

/** Classical MDS → 2D coords preserving cosine distances (for the scatter map). */
export function mds2d(vectors) {
  const n = vectors.length;
  if (n < 2) return vectors.map(() => ({ x: 0, y: 0 }));
  const D2 = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => {
      const d = i === j ? 0 : cosineDistance(vectors[i], vectors[j]);
      return d * d;
    }),
  );
  const rowMean = D2.map((row) => row.reduce((s, x) => s + x, 0) / n);
  const total = rowMean.reduce((s, x) => s + x, 0) / n;
  const B = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => -0.5 * (D2[i][j] - rowMean[i] - rowMean[j] + total)),
  );
  const { values, vectors: evecs } = jacobiEigen(B);
  const order = values.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const take = [order[0], order[1] ?? order[0]];
  return Array.from({ length: n }, (_, i) =>
    Object.fromEntries(
      take.map(([val, col], ax) => [
        ax === 0 ? 'x' : 'y',
        val > 1e-12 ? evecs[i][col] * Math.sqrt(val) : 0,
      ]),
    ),
  );
}

/** Cyclic Jacobi eigensolver for small symmetric matrices (n ≤ ~60). */
function jacobiEigen(A, sweeps = 24) {
  const n = A.length;
  const a = A.map((row) => row.slice());
  let v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++)
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-14) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-15) continue;
        const app = a[p][p];
        const aqq = a[q][q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

export function silhouetteLabel(s) {
  if (s == null) return 'n/a';
  if (s > 0.5) return 'strong structure';
  if (s > 0.25) return 'reasonable structure';
  if (s > 0) return 'weak / overlapping';
  return 'misassigned — try another k';
}
