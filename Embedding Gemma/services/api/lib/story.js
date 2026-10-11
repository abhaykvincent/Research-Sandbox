// Milestone 6 — storytelling sequence builder (server-side).
// Pure functions, no external deps. Mirrors apps/web/src/utils/story.js so
// local preview and POST /api/story-sequence agree bit-for-bit on the same
// inputs (same PRNG + k-means++ restarts).
//
// Pipeline: k-means over cosine geometry → 1 representative per cluster
// (closest to centroid) → fill to targetCount by centrality → order the
// picks (chrono | cluster-flow | diverse walk) → chapters + captions + scores.

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
  if (!a?.length || !b?.length || a.length !== b.length) return null;
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
        next[c] = normed[Math.floor(rand() * n)].slice();
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

const clampInt = (n, lo, hi, dflt) => {
  n = Number(n);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** Sort key for chronological order: real capture time first, name fallback. */
export function chronoKey(it) {
  const t = Number(it?.capturedAt);
  if (Number.isFinite(t) && t > 0) return [0, t, String(it.name ?? '')];
  return [1, 0, String(it.name ?? '')];
}

function compareChrono(a, b) {
  const ka = chronoKey(a);
  const kb = chronoKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function captionFor(pos, total, cluster, centrality) {
  const beat = total <= 1 ? 'Single highlight' : pos === 0 ? 'Opener' : pos === total - 1 ? 'Finale' : `Beat ${pos + 1}`;
  const conf = centrality == null ? '' : ` · match ${centrality.toFixed(2)}`;
  return `${beat} — Moment ${cluster + 1}${conf}`;
}

/**
 * Build a draft highlight sequence from embedding vectors.
 * @param {Array<{name:string, vector:number[], capturedAt?:number|null}>} items
 * @param {{k?:number, targetCount?:number, ordering?:string, seed?:number}} opts
 */
export function buildStory(items, opts = {}) {
  const n = items?.length ?? 0;
  if (n < 2) throw new Error(`Need ≥2 photos for a story (got ${n})`);
  const k = clampInt(opts.k, 2, Math.min(8, n - 1), Math.min(3, n - 1));
  const targetCount = clampInt(opts.targetCount, 1, Math.min(20, n), Math.min(8, n));
  const ordering = ['chrono', 'cluster', 'diverse'].includes(opts.ordering) ? opts.ordering : 'chrono';
  const seed = Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : 42;

  const vectors = items.map((i) => i.vector);
  const km = kmeans(vectors, k, { restarts: 8, seed });
  const { labels, centroids, normed } = km;

  // Centrality = cosine similarity of each photo to its own centroid.
  const centrality = normed.map((v, i) => cosineSimilarity(v, centroids[labels[i]]) ?? -2);
  const clusters = Array.from({ length: k }, (_, c) => {
    const members = labels.map((l, i) => (l === c ? i : -1)).filter((i) => i >= 0);
    const byCentral = [...members].sort((a, b) => centrality[b] - centrality[a]);
    const times = members.map((i) => Number(items[i].capturedAt)).filter((t) => Number.isFinite(t) && t > 0);
    times.sort((a, b) => a - b);
    const medianTime = times.length ? times[Math.floor(times.length / 2)] : null;
    return { id: c, members, size: members.length, rep: byCentral[0] ?? members[0] ?? 0, medianTime };
  });

  // Selection: one rep per cluster (largest clusters first when trimming),
  // then fill remaining slots by global centrality.
  const bySize = [...clusters].sort((a, b) => b.size - a.size);
  const picked = [];
  const pickedSet = new Set();
  for (const cl of bySize) {
    if (picked.length >= targetCount) break;
    if (cl.rep != null && !pickedSet.has(cl.rep)) {
      picked.push(cl.rep);
      pickedSet.add(cl.rep);
    }
  }
  if (picked.length < targetCount) {
    const rest = normed.map((_, i) => i).sort((a, b) => centrality[b] - centrality[a]);
    for (const i of rest) {
      if (picked.length >= targetCount) break;
      if (!pickedSet.has(i)) {
        picked.push(i);
        pickedSet.add(i);
      }
    }
  }

  // Ordering.
  let order = [...picked];
  if (ordering === 'chrono') {
    order.sort((a, b) => compareChrono(items[a], items[b]));
  } else if (ordering === 'cluster') {
    const clusterRank = new Map(
      [...clusters].sort((a, b) => (a.medianTime ?? Infinity) - (b.medianTime ?? Infinity) || b.size - a.size).map((c, r) => [c.id, r]),
    );
    order.sort((a, b) => (clusterRank.get(labels[a]) - clusterRank.get(labels[b])) || (centrality[b] - centrality[a]));
  } else {
    // Diverse walk: start at the most central rep, then repeatedly pick the
    // candidate farthest (min cosine) from everything already sequenced.
    const start = [...picked].sort((a, b) => centrality[b] - centrality[a])[0];
    const remaining = new Set(picked);
    remaining.delete(start);
    order = [start];
    while (remaining.size) {
      let bestIdx = -1;
      let bestScore = Infinity;
      for (const cand of remaining) {
        let worst = -2; // max similarity to the sequence so far (lower = more novel)
        for (const s of order) {
          const sim = cosineSimilarity(normed[cand], normed[s]) ?? 0;
          if (sim > worst) worst = sim;
        }
        if (worst < bestScore) {
          bestScore = worst;
          bestIdx = cand;
        }
      }
      order.push(bestIdx);
      remaining.delete(bestIdx);
    }
  }

  const sequence = order.map((srcIdx, pos) => ({
    position: pos + 1,
    name: items[srcIdx].name,
    cluster: labels[srcIdx],
    centrality: centrality[srcIdx],
    capturedAt: items[srcIdx].capturedAt ?? null,
    caption: captionFor(pos, order.length, labels[srcIdx], centrality[srcIdx]),
    sourceIndex: srcIdx,
  }));

  // Chapters: group consecutive same-cluster runs so the timeline reads like
  // Opener → moments → Finale instead of a flat list.
  const chapters = [];
  for (const shot of sequence) {
    const last = chapters[chapters.length - 1];
    if (last && last.cluster === shot.cluster) last.shots.push(shot);
    else chapters.push({ id: chapters.length, cluster: shot.cluster, title: `Chapter ${chapters.length + 1} — Moment ${shot.cluster + 1}`, shots: [shot] });
  }

  // Scores.
  const distinct = new Set(sequence.map((s) => s.cluster)).size;
  const coverage = k ? distinct / k : 0;
  const adj = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const sim = cosineSimilarity(normed[sequence[i].sourceIndex], normed[sequence[i + 1].sourceIndex]);
    if (sim != null) adj.push(sim);
  }
  const redundancy = adj.length ? adj.reduce((s, x) => s + x, 0) / adj.length : 0;
  const flow = 1 - redundancy; // higher = more visual variety between cuts
  const durationSec = sequence.length * 3; // 3s per highlight in the player

  return {
    k,
    targetCount: sequence.length,
    ordering,
    seed,
    dims: vectors[0].length,
    count: n,
    labels,
    clusters: clusters.map((c) => ({ id: c.id, size: c.size, rep: items[c.rep]?.name ?? null, medianTime: c.medianTime })),
    sequence,
    chapters,
    scores: { coverage, redundancy, flow, durationSec, distinctClusters: distinct },
  };
}
