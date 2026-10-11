import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { kmeans, sweepK, silhouetteScore, mds2d, cosineSimilarity, silhouetteLabel } from '../utils/cluster.js';
import { blog } from '../utils/debugLog.js';

const API_URL = import.meta.env.VITE_API_URL || '';
const PALETTE = ['#d6a85c', '#4ade80', '#60a5fa', '#f472b6', '#a78bfa', '#fbbf24', '#2dd4bf', '#fb7185'];
const colorFor = (c) => PALETTE[c % PALETTE.length];

async function embedFile(file, dims) {
  const form = new FormData();
  form.append('image', file);
  form.append('outputDimensionality', String(dims));
  form.append('includeVector', 'true');
  const res = await fetch(`${API_URL}/api/embeddings`, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Embed failed: ${res.status}`);
  if (!data.vector?.length) throw new Error(`No vector for ${file.name}`);
  return { name: file.name, vector: data.vector, dim: data.dimension, file };
}

/** Deterministic placeholder so a tile always shows an image, even when the
 *  server preview 404s (old batch) or a local object URL was revoked. */
function placeholderFor(name = '?') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const initial = (name.split('/').pop()?.[0] ?? '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="hsl(${hue},30%,22%)"/><text x="50%" y="54%" font-family="sans-serif" font-size="96" font-weight="700" fill="hsl(${hue},60%,75%)" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function ThumbImg({ src, alt, className }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  return <img src={err || !src ? placeholderFor(alt) : src} alt={alt} loading="lazy" onError={() => setErr(true)} className={className} />;
}

export default function ClusteringExperiment() {
  const { batchId, batch } = useSelector((s) => s.batch);
  const [items, setItems] = useState([]); // { name, vector, dim, thumbUrl? }
  const [thumbFiles, setThumbFiles] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | failed
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [dims, setDims] = useState(768);
  const [k, setK] = useState(3);
  const [sweep, setSweep] = useState(null); // { rows, bestK }
  const [sweeping, setSweeping] = useState(false);
  const [sel, setSel] = useState(null); // selected photo index
  const [filter, setFilter] = useState(null); // focused cluster or null

  // Revocable object URLs for attached/uploaded thumbnails
  const [urls, setUrls] = useState({});
  useEffect(() => () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const rememberFiles = (files) => {
    const next = {};
    for (const f of files) next[f.name] = URL.createObjectURL(f);
    setUrls((prev) => {
      Object.values(prev).forEach((u) => URL.revokeObjectURL(u));
      return next;
    });
  };

  // Locally attached files win; otherwise use the server preview so
  // batch c-thumbs show the actual photo without any manual attach step.
  const serverThumb = (batchIdFor, name) =>
    batchIdFor ? `${API_URL}/api/batch-jobs/${batchIdFor}/thumb?file=${encodeURIComponent(name)}` : null;

  const withThumbs = (list) => list.map((it) => ({ ...it, thumbUrl: urls[it.name] ?? it.thumbUrl }));

  const [thumbNote, setThumbNote] = useState(null);

  const loadBatch = async () => {
    if (!batchId) return;
    setStatus('loading');
    setError(null);
    setSweep(null);
    setThumbNote(null);
    try {
      blog.log('cluster loading batch vectors', { batchId: batchId.slice(0, 8) });
      const res = await fetch(`${API_URL}/api/batch-jobs/${batchId}?includeVectors=true`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Fetch failed: ${res.status}`);
      const vec = (data.items ?? [])
        .map((i) => ({
          name: i.fileName,
          vector: i.vector ?? i._vector,
          dim: (i.vector ?? i._vector)?.length,
          // The server thumb is the only image we have for batch photos —
          // always point at it; a placeholder covers the 404 case below.
          thumbUrl: serverThumb(batchId, i.fileName),
          hasThumb: i.hasThumb !== false,
        }))
        .filter((i) => i.vector?.length);
      if (vec.length < 3) throw new Error(`Need ≥3 vectors to cluster (got ${vec.length})`);
      if (new Set(vec.map((v) => v.vector.length)).size > 1) throw new Error('Mixed vector dims — re-run batch with one dims setting');
      const withPreview = vec.filter((v) => v.hasThumb).length;
      if (withPreview < vec.length) {
        setThumbNote(
          `${vec.length - withPreview} photo(s) predate server previews — showing placeholders until you re-process the shoot or attach thumbnails below.`,
        );
      }
      setItems(vec);
      setSource('batch');
      setK(Math.min(3, vec.length - 1));
      setSel(null);
      setFilter(null);
      setStatus('ready');
      blog.log('cluster batch loaded', { n: vec.length, withPreview });
    } catch (err) {
      setStatus('failed');
      setError(err.message);
      blog.error('cluster batch load FAILED', { error: err.message });
    }
  };

  const embedUploads = async (files) => {
    const list = files.slice(0, 30);
    if (list.length < 3) {
      setError('Select at least 3 photos to cluster.');
      return;
    }
    setStatus('loading');
    setError(null);
    setSweep(null);
    rememberFiles(list);
    try {
      const out = [];
      for (const f of list) {
        blog.log(`cluster embedding ${f.name}…`);
        const r = await embedFile(f, dims);
        out.push({ ...r, thumbUrl: URL.createObjectURL(f) });
        setItems([...out]);
      }
      setSource('upload');
      setK(Math.min(3, out.length - 1));
      setSel(null);
      setFilter(null);
      setStatus('ready');
    } catch (err) {
      setStatus('failed');
      setError(err.message);
    }
  };

  const result = useMemo(() => {
    if (items.length < 3) return null;
    const kk = Math.min(k, items.length - 1);
    try {
      const vectors = items.map((i) => i.vector);
      const km = kmeans(vectors, kk, { restarts: 8, seed: 42 });
      const sil = silhouetteScore(vectors, km.labels);
      const proj = mds2d(vectors);
      const clusters = Array.from({ length: kk }, (_, c) => {
        const members = km.labels.map((l, i) => (l === c ? i : -1)).filter((i) => i >= 0);
        const sims = [];
        for (let a = 0; a < members.length; a++)
          for (let b = a + 1; b < members.length; b++)
            sims.push(cosineSimilarity(vectors[members[a]], vectors[members[b]]));
        const intra = sims.length ? sims.reduce((s, x) => s + x, 0) / sims.length : 1;
        // Representative = closest to centroid in cosine space
        let rep = members[0];
        let best = -2;
        members.forEach((i) => {
          const s = cosineSimilarity(km.normed[i], km.centroids[c]);
          if (s > best) {
            best = s;
            rep = i;
          }
        });
        const order = [...members].sort((a, b) => {
          const sa = cosineSimilarity(km.normed[a], km.centroids[c]);
          const sb = cosineSimilarity(km.normed[b], km.centroids[c]);
          return sb - sa;
        });
        return { id: c, members, intra, rep, repSim: best, order };
      });
      return { ...km, k: kk, sil, proj, clusters, dims: vectors[0].length };
    } catch (err) {
      return { error: err.message };
    }
  }, [items, k]);

  const onSweep = () => {
    if (items.length < 3) return;
    setSweeping(true);
    // setTimeout keeps the button responsive; n≤50 so the sweep is <1s
    setTimeout(() => {
      try {
        const r = sweepK(items.map((i) => i.vector), 2, Math.min(6, items.length - 1), { restarts: 6, seed: 7 });
        setSweep(r);
        if (r.bestK) setK(r.bestK);
        blog.log('cluster auto-k sweep', r);
      } catch (err) {
        setError(err.message);
      }
      setSweeping(false);
    }, 30);
  };

  const view = useMemo(() => (items.length ? withThumbs(items) : items), [items, urls]); // eslint-disable-line

  // Scatter bounds
  const bounds = useMemo(() => {
    if (!result?.proj) return null;
    const xs = result.proj.map((p) => p.x);
    const ys = result.proj.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const pad = (v) => (v === 0 ? 1 : v * 0.12);
    return { x0: x0 - pad(x1 - x0), x1: x1 + pad(x1 - x0), y0: y0 - pad(y1 - y0), y1: y1 + pad(y1 - y0) };
  }, [result]);

  const W = 640;
  const H = 300;
  const toXY = (p) => [
    ((p.x - bounds.x0) / (bounds.x1 - bounds.x0 || 1)) * (W - 48) + 24,
    H - (((p.y - bounds.y0) / (bounds.y1 - bounds.y0 || 1)) * (H - 48) + 24),
  ];

  const maxK = items.length >= 3 ? Math.min(8, items.length - 1) : 3;

  return (
    <section className="card">
      <h2>Milestone 5 — Clustering experiment</h2>
      <p className="muted">
        K-means over cosine geometry (L2-normalized Gemini vectors, k-means++ × 8 restarts) finds visually
        related moments. {batchId ? <>Current batch <code>{batchId.slice(0, 8)}</code> ({batch?.completed ?? '?'}/{batch?.total ?? '?'} ok).</> : 'Process a batch first, or embed photos directly.'}
      </p>

      <div className="row">
        <button disabled={!batchId || status === 'loading'} onClick={loadBatch}>
          {status === 'loading' && source !== 'upload' ? 'Loading…' : 'Cluster current batch'}
        </button>
        <label className="muted">or embed
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => embedUploads(Array.from(e.target.files ?? []))} />
        </label>
        <label>dims
          <select value={dims} onChange={(e) => setDims(Number(e.target.value))}>
            <option value={128}>128</option>
            <option value={768}>768</option>
            <option value={1536}>1536</option>
          </select>
        </label>
      </div>
      {source === 'batch' && (
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <label className="muted">attach thumbnails (optional)
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => { setThumbFiles(Array.from(e.target.files ?? [])); rememberFiles(Array.from(e.target.files ?? [])); }} />
          </label>
          {thumbFiles.length > 0 && <span className="muted">{thumbFiles.length} matched by file name</span>}
        </div>
      )}
      {error && <p className="error">Error: {error}</p>}
      {thumbNote && <p className="warn">{thumbNote}</p>}
      {result?.error && <p className="error">Clustering error: {result.error}</p>}

      {result && !result.error && (
        <>
          <div className="row cluster-controls">
            <label>k = <strong>{result.k}</strong>
              <input type="range" min={2} max={maxK} value={result.k} onChange={(e) => setK(Number(e.target.value))} />
            </label>
            <button disabled={sweeping || items.length < 4} onClick={onSweep}>
              {sweeping ? 'Sweeping…' : 'Auto-find k'}
            </button>
            {sweep && <span className="muted">best k = <strong>{sweep.bestK}</strong> by silhouette</span>}
            <span className={`sil-badge ${result.sil.score > 0.5 ? 'ok' : result.sil.score > 0.25 ? 'warn' : 'bad'}`}>
              silhouette {result.sil.score?.toFixed(3) ?? 'n/a'} · {silhouetteLabel(result.sil.score)}
            </span>
          </div>

          {sweep && (
            <div className="sim-table-wrap">
              <table className="sim-table">
                <thead><tr><th>k</th><th>silhouette ↑</th><th>inertia ↓</th><th></th></tr></thead>
                <tbody>
                  {sweep.rows.map((r) => (
                    <tr key={r.k} className={r.k === result.k ? 'active-k' : ''}>
                      <td>{r.k}{r.k === sweep.bestK ? ' ★' : ''}</td>
                      <td>{r.silhouette?.toFixed(3) ?? 'n/a'}</td>
                      <td>{r.inertia.toFixed(2)}</td>
                      <td><button className="link" onClick={() => setK(r.k)}>use</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {bounds && (
            <div className="scatter-wrap">
              <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img" aria-label="2D cluster map">
                {result.proj.map((p, i) => {
                  const [x, y] = toXY(p);
                  const c = result.labels[i];
                  const dim = filter != null && c !== filter;
                  const isSel = sel === i;
                  return (
                    <g key={i} opacity={dim ? 0.25 : 1} onClick={() => { setSel(i); setFilter(null); }} style={{ cursor: 'pointer' }}>
                      <title>{view[i]?.name} — cluster {c + 1}</title>
                      <circle cx={x} cy={y} r={isSel ? 11 : 8} fill={colorFor(c)} fillOpacity={0.85} stroke={isSel ? '#fff' : 'none'} strokeWidth={2} />
                      <text x={x} y={y + 3.5} textAnchor="middle" fontSize={8} fill="#101014" fontWeight={700}>{c + 1}</text>
                    </g>
                  );
                })}
              </svg>
              <div className="scatter-legend">
                {result.clusters.map((cl) => (
                  <button key={cl.id} className={`legend ${filter === cl.id ? 'on' : ''}`} onClick={() => setFilter(filter === cl.id ? null : cl.id)}>
                    <span className="dot" style={{ background: colorFor(cl.id) }} />C{cl.id + 1} · {cl.members.length}
                  </button>
                ))}
                <span className="muted">MDS map preserves cosine distances · click a point to inspect</span>
              </div>
            </div>
          )}

          {sel != null && view[sel] && (
            <div className="sel-detail">
              <strong>{view[sel].name}</strong>
              <span> cluster C{(result.labels[sel] ?? 0) + 1}</span>
              <span> silhouette {result.sil.perPoint[sel]?.toFixed(3) ?? 'n/a'}</span>
              <button className="link" onClick={() => setSel(null)}>clear</button>
            </div>
          )}

          <div className="cluster-grid">
            {result.clusters
              .filter((cl) => filter == null || cl.id === filter)
              .map((cl) => (
                <div key={cl.id} className="cluster-card" style={{ borderTopColor: colorFor(cl.id) }}>
                  <div className="c-head">
                    <span className="dot" style={{ background: colorFor(cl.id) }} />
                    <strong>Cluster {cl.id + 1}</strong>
                    <span className="muted">{cl.members.length} photos · intra-sim {cl.intra.toFixed(3)}</span>
                  </div>
                  <div className="c-cover">
                    <ThumbImg src={view[cl.rep]?.thumbUrl} alt={view[cl.rep]?.name} />
                    <div className="c-cover-meta">★ representative · {view[cl.rep]?.name} · sim-to-center {cl.repSim?.toFixed(3)}</div>
                  </div>
                  <div className="c-members">
                    {cl.order.map((i) => (
                      <button key={i} className={`c-thumb ${sel === i ? 'sel' : ''}`} onClick={() => setSel(i)} title={`${view[i]?.name} · sil ${result.sil.perPoint[i]?.toFixed(3) ?? 'n/a'}`}>
                        <ThumbImg src={view[i]?.thumbUrl} alt={view[i]?.name} />
                        <span className="c-cap" title={view[i]?.name}>{view[i]?.name}</span>
                        <span className="c-dot" style={{ background: colorFor(cl.id) }} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
          </div>
          <p className="muted">Tip: intra-sim near 1 = tight moment (ceremony, dance floor). Low silhouette or tiny clusters → try k±1 or Auto-find k. Representatives (★) feed Milestone 6 storytelling.</p>
        </>
      )}
    </section>
  );
}
