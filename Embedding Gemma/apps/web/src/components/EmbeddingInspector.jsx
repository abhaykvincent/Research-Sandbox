import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { cosineSimilarity } from '../utils/cosine.js';
import { blog } from '../utils/debugLog.js';

const API_URL = import.meta.env.VITE_API_URL || '';

async function embedFile(file, outputDimensionality) {
  const t0 = performance.now();
  const form = new FormData();
  form.append('image', file);
  form.append('outputDimensionality', String(outputDimensionality));
  form.append('includeVector', 'true');
  const res = await fetch(`${API_URL}/api/embeddings`, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Embed failed: ${res.status}`);
  return { ...data, fileName: file.name, ms: data.processingTimeMs ?? Math.round(performance.now() - t0) };
}

export default function EmbeddingInspector() {
  const { batchId, batch } = useSelector((s) => s.batch);
  const [files, setFiles] = useState([]);
  const [thumbs, setThumbs] = useState([]);
  const [dims, setDims] = useState(768);
  const [rows, setRows] = useState([]); // { fileName, dimension, ms, vector, thumbUrl }
  const [status, setStatus] = useState('idle'); // idle | working | done | failed
  const [error, setError] = useState(null);
  const [refIdx, setRefIdx] = useState(0);
  const [batchSim, setBatchSim] = useState(null); // { names, matrix, top }

  useEffect(() => {
    const urls = files.map((f) => ({ name: f.name, url: URL.createObjectURL(f) }));
    setThumbs(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u.url));
  }, [files]);

  const thumbFor = (name) => thumbs.find((t) => t.name === name)?.url;

  const matrix = useMemo(() => {
    if (rows.length < 2) return null;
    return rows.map((a) => rows.map((b) => (a === b ? 1 : cosineSimilarity(a.vector, b.vector))));
  }, [rows]);

  const topPair = useMemo(() => {
    if (!matrix) return null;
    let best = { i: 0, j: 1, v: -2 };
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const v = matrix[i][j];
        if (v != null && v > best.v) best = { i, j, v };
      }
    return best.v === -2 ? null : best;
  }, [matrix, rows]);

  const ranked = useMemo(() => {
    if (rows.length < 2 || !rows[refIdx]?.vector) return [];
    return rows
      .map((r, i) => ({ i, name: r.fileName, sim: i === refIdx ? 1 : cosineSimilarity(rows[refIdx].vector, r.vector) }))
      .filter((r) => r.i !== refIdx)
      .sort((a, b) => (b.sim ?? -2) - (a.sim ?? -2));
  }, [rows, refIdx]);

  const onCompare = async () => {
    if (files.length < 2) return;
    setStatus('working');
    setError(null);
    setRows([]);
    setRefIdx(0);
    blog.log(`inspector compare START`, { n: files.length, dims });
    try {
      const out = [];
      for (const f of files.slice(0, 10)) {
        blog.log(`inspector embedding ${f.name}…`);
        const r = await embedFile(f, dims);
        if (!r.vector?.length) throw new Error(`No vector returned for ${f.name}`);
        out.push({ fileName: f.name, dimension: r.dimension, ms: r.ms, vector: r.vector, preview: r.vectorPreview });
        setRows([...out]);
      }
      setStatus('done');
      blog.log(`inspector compare DONE`, { n: out.length });
    } catch (err) {
      setStatus('failed');
      setError(err.message);
      blog.error('inspector compare FAILED', { error: err.message });
    }
  };

  const onLoadBatch = async () => {
    if (!batchId) return;
    setError(null);
    try {
      blog.log('inspector loading batch vectors', { batchId: batchId.slice(0, 8) });
      const res = await fetch(`${API_URL}/api/batch-jobs/${batchId}?includeVectors=true`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Fetch failed: ${res.status}`);
      const ok = (data.items ?? []).filter((i) => i.status === 'succeeded' && i._vector?.length);
      // Server sends `vector` when includeVectors=true; fall back to `_vector` for safety.
      const withVec = (data.items ?? [])
        .map((i) => ({ ...i, vec: i.vector ?? i._vector }))
        .filter((i) => i.status === 'succeeded' && i.vec?.length);
      if (withVec.length < 2) throw new Error(`Need ≥2 succeeded items with vectors (got ${withVec.length}). Batch may predate vector fetch or dims differ.`);
      const dimsSet = new Set(withVec.map((i) => i.vec.length));
      if (dimsSet.size > 1) throw new Error(`Mixed vector dims in batch (${[...dimsSet].join(', ')}). Re-run batch with one dims setting.`);
      const names = withVec.map((i) => i.fileName);
      const m = withVec.map((a) => withVec.map((b) => (a === b ? 1 : cosineSimilarity(a.vec, b.vec))));
      let top = { i: 0, j: 1, v: -2 };
      for (let i = 0; i < withVec.length; i++)
        for (let j = i + 1; j < withVec.length; j++) if (m[i][j] != null && m[i][j] > top.v) top = { i, j, v: m[i][j] };
      setBatchSim({ names, matrix: m, top: top.v === -2 ? null : top, n: withVec.length, dims: withVec[0].vec.length, ok });
      blog.log('inspector batch matrix DONE', { n: withVec.length, dims: withVec[0].vec.length });
    } catch (err) {
      setError(err.message);
      blog.error('inspector batch load FAILED', { error: err.message });
    }
  };

  const simCell = (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const cls = v > 0.9 ? 'sim-hi' : v > 0.75 ? 'sim-mid' : 'sim-lo';
    return <span className={cls}>{v.toFixed(3)}</span>;
  };

  return (
    <section className="card">
      <h2>Milestone 4 — Embedding inspector</h2>
      <p className="muted">
        Thumbnails + dims + timing + cosine similarity. Pick 2–10 photos → Compare, or load vectors
        from the current batch ({batchId ? <code>{batchId.slice(0, 8)}</code> : 'none yet'}
        {batch ? ` · ${batch.completed}/${batch.total} ok` : ''}).
      </p>

      <div className="row">
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} />
        <label>dims
          <select value={dims} onChange={(e) => setDims(Number(e.target.value))}>
            <option value={128}>128</option>
            <option value={768}>768</option>
            <option value={1536}>1536</option>
          </select>
        </label>
        <button disabled={files.length < 2 || status === 'working'} onClick={onCompare}>
          {status === 'working' ? `Embedding ${rows.length}/${files.length}…` : `Compare ${files.length} photos`}
        </button>
        <button disabled={!batchId} onClick={onLoadBatch} title={batchId ? 'GET /api/batch-jobs/:id?includeVectors=true' : 'Process a batch first'}>
          Load batch vectors
        </button>
      </div>
      {files.length > 0 && files.length < 2 && <p className="warn">Select at least 2 photos to compare.</p>}
      {error && <p className="error">Error: {error}</p>}

      {rows.length > 0 && (
        <>
          <div className="insp-grid">
            {rows.map((r, i) => (
              <button key={r.fileName + i} className={`thumb ${i === refIdx ? 'ref' : ''}`} onClick={() => setRefIdx(i)} title="Click to set as reference">
                {thumbFor(r.fileName) && <img src={thumbFor(r.fileName)} alt={r.fileName} />}
                <span className="t-name">{r.fileName}{i === refIdx ? ' ★' : ''}</span>
                <span className="t-meta">dim {r.dimension} · {r.ms}ms</span>
                <span className="t-meta vec">{r.preview?.slice(0, 4).map((v) => v.toFixed(3)).join(', ')}…</span>
              </button>
            ))}
          </div>

          {matrix && (
            <>
              <h3>Pairwise cosine similarity ({rows[0].dimension}d)</h3>
              {topPair && <p className="muted">Most similar: <strong>{rows[topPair.i].fileName}</strong> ↔ <strong>{rows[topPair.j].fileName}</strong> ({topPair.v.toFixed(3)})</p>}
              <div className="sim-table-wrap">
                <table className="sim-table">
                  <thead><tr><th></th>{rows.map((r, i) => <th key={i} title={r.fileName}>{r.fileName.slice(0, 10)}{i === refIdx ? ' ★' : ''}</th>)}</tr></thead>
                  <tbody>
                    {matrix.map((rowArr, i) => (
                      <tr key={i}>
                        <th title={rows[i].fileName}>{rows[i].fileName.slice(0, 10)}{i === refIdx ? ' ★' : ''}</th>
                        {rowArr.map((v, j) => <td key={j} className={i === j ? 'diag' : ''}>{simCell(v)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Ranked vs reference: {rows[refIdx]?.fileName} ★ <span className="muted">(click a thumbnail to change)</span></h3>
              <ul className="ranked">
                {ranked.map((r) => (
                  <li key={r.i}><span>{r.name}</span><span>{r.sim == null ? '—' : r.sim.toFixed(4)}</span></li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {batchSim && (
        <>
          <h3>Batch similarity — {batchSim.n} vectors @ {batchSim.dims}d</h3>
          {batchSim.top && <p className="muted">Most similar: <strong>{batchSim.names[batchSim.top.i]}</strong> ↔ <strong>{batchSim.names[batchSim.top.j]}</strong> ({batchSim.top.v.toFixed(3)})</p>}
          <div className="sim-table-wrap">
            <table className="sim-table">
              <thead><tr><th></th>{batchSim.names.map((n, i) => <th key={i} title={n}>{n.slice(0, 10)}</th>)}</tr></thead>
              <tbody>
                {batchSim.matrix.map((rowArr, i) => (
                  <tr key={i}>
                    <th title={batchSim.names[i]}>{batchSim.names[i].slice(0, 10)}</th>
                    {rowArr.map((v, j) => <td key={j} className={i === j ? 'diag' : ''}>{simCell(v)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
