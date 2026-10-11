// Milestone 6 — client-side storytelling sequence builder.
// Same algorithm as services/api/lib/story.js (same k-means++ restarts +
// PRNG), so the instant local preview matches POST /api/story-sequence.
// Local-first keeps the k / length / ordering sliders at 60fps; the server
// endpoint remains the source of truth for sharing + future LLM captions.

import { kmeans, cosineSimilarity } from './cluster.js';

export const ORDERINGS = [
  { id: 'chrono', label: 'Chronological', hint: 'shoot order — best for wedding-day flow' },
  { id: 'cluster', label: 'Moment by moment', hint: 'one chapter per cluster, in shoot order' },
  { id: 'diverse', label: 'Max variety', hint: 'greedy farthest-point walk — no two adjacent shots look alike' },
];

const clampInt = (n, lo, hi, dflt) => {
  n = Number(n);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

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

  const centrality = normed.map((v, i) => cosineSimilarity(v, centroids[labels[i]]) ?? -2);
  const clusters = Array.from({ length: k }, (_, c) => {
    const members = labels.map((l, i) => (l === c ? i : -1)).filter((i) => i >= 0);
    const byCentral = [...members].sort((a, b) => centrality[b] - centrality[a]);
    const times = members.map((i) => Number(items[i].capturedAt)).filter((t) => Number.isFinite(t) && t > 0);
    times.sort((a, b) => a - b);
    const medianTime = times.length ? times[Math.floor(times.length / 2)] : null;
    return { id: c, members, size: members.length, rep: byCentral[0] ?? members[0] ?? 0, medianTime };
  });

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

  let order = [...picked];
  if (ordering === 'chrono') {
    order.sort((a, b) => compareChrono(items[a], items[b]));
  } else if (ordering === 'cluster') {
    const clusterRank = new Map(
      [...clusters].sort((a, b) => (a.medianTime ?? Infinity) - (b.medianTime ?? Infinity) || b.size - a.size).map((c, r) => [c.id, r]),
    );
    order.sort((a, b) => (clusterRank.get(labels[a]) - clusterRank.get(labels[b])) || (centrality[b] - centrality[a]));
  } else {
    const start = [...picked].sort((a, b) => centrality[b] - centrality[a])[0];
    const remaining = new Set(picked);
    remaining.delete(start);
    order = [start];
    while (remaining.size) {
      let bestIdx = -1;
      let bestScore = Infinity;
      for (const cand of remaining) {
        let worst = -2;
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

  const chapters = [];
  for (const shot of sequence) {
    const last = chapters[chapters.length - 1];
    if (last && last.cluster === shot.cluster) last.shots.push(shot);
    else chapters.push({ id: chapters.length, cluster: shot.cluster, title: `Chapter ${chapters.length + 1} — Moment ${shot.cluster + 1}`, shots: [shot] });
  }

  const distinct = new Set(sequence.map((s) => s.cluster)).size;
  const coverage = k ? distinct / k : 0;
  const adj = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const sim = cosineSimilarity(normed[sequence[i].sourceIndex], normed[sequence[i + 1].sourceIndex]);
    if (sim != null) adj.push(sim);
  }
  const redundancy = adj.length ? adj.reduce((s, x) => s + x, 0) / adj.length : 0;
  const flow = 1 - redundancy;
  const durationSec = sequence.length * 3;

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

/** Human caption for a capture timestamp (or '' when unknown). */
export function formatShotTime(ts) {
  if (!ts || !Number.isFinite(Number(ts))) return '';
  try {
    const d = new Date(Number(ts));
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** POST /api/story-sequence — server-side twin of buildStory (for parity checks). */
export async function fetchServerStory(apiUrl, body) {
  const res = await fetch(`${apiUrl}/api/story-sequence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Story failed: ${res.status}`);
  return data;
}
