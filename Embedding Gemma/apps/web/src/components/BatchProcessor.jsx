import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { createBatch, fetchBatch, retryBatch, setBatchId } from '../store/batchSlice.js';

export default function BatchProcessor() {
  const dispatch = useDispatch();
  const { batchId, batch, status, error, polling } = useSelector((s) => s.batch);
  const [files, setFiles] = useState([]);
  const [dims, setDims] = useState(768);
  const [concurrency, setConcurrency] = useState(4);
  const [resumeId, setResumeId] = useState('');
  const timer = useRef(null);

  // Poll while processing
  useEffect(() => {
    if (polling && batchId) {
      dispatch(fetchBatch(batchId));
      timer.current = setInterval(() => dispatch(fetchBatch(batchId)), 1500);
    }
    return () => clearInterval(timer.current);
  }, [polling, batchId, dispatch]);

  // Resume last batch on load (resumability)
  useEffect(() => {
    if (batchId && !batch) dispatch(fetchBatch(batchId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFiles = (e) => setFiles(Array.from(e.target.files ?? []).slice(0, 50));
  const done = (batch?.completed ?? 0) + (batch?.failed ?? 0);
  const pct = batch?.total ? Math.round((done / batch.total) * 100) : 0;

  return (
    <section className="card">
      <h2>Milestone 3 — Batch photo processing</h2>
      <p className="muted">
        Load a small shoot folder (≤50 files). Server embeds with bounded concurrency, retries,
        SHA-256 cache, and persisted jobs. Failed items can be retried without re-uploading.
      </p>

      <div className="row">
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={onFiles} />
        <label>dims
          <select value={dims} onChange={(e) => setDims(Number(e.target.value))}>
            <option value={128}>128</option>
            <option value={768}>768</option>
            <option value={1536}>1536</option>
          </select>
        </label>
        <label>concurrency
          <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            <option value={2}>2</option>
            <option value={4}>4</option>
            <option value={8}>8</option>
          </select>
        </label>
        <button
          disabled={files.length === 0 || status === 'uploading' || polling}
          onClick={() => dispatch(createBatch({ files, outputDimensionality: dims, concurrency }))}
        >
          {status === 'uploading' ? 'Uploading…' : `Process ${files.length} photos`}
        </button>
      </div>
      {files.length > 0 && <p className="muted">{files.length} selected (first: {files[0].name})</p>}

      <div className="row resume">
        <input placeholder="paste batchId to resume" value={resumeId} onChange={(e) => setResumeId(e.target.value)} />
        <button onClick={() => resumeId && (dispatch(setBatchId(resumeId)), dispatch(fetchBatch(resumeId)))}>
          Resume job
        </button>
        {batchId && <span className="muted">current: <code>{batchId.slice(0, 8)}</code></span>}
      </div>

      {error && <p className="error">Error: {error}</p>}

      {batch && (
        <div className="batch">
          <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
          <p className="muted">
            {batch.status} · {batch.completed}/{batch.total} ok · {batch.failed} failed · {batch.pending} pending · {pct}%
            {batch.items?.some((i) => i.cacheHit) && ' · cache hits ✓'}
          </p>
          <ul className="items">
            {batch.items.map((it) => (
              <li key={it.jobId} className={it.status}>
                <span>{it.fileName}</span>
                <span>{it.status}{it.cacheHit ? ' (cached)' : ''}{it.attempts > 1 ? ` · ${it.attempts} tries` : ''}</span>
                <span>{it.dimension ? `dim ${it.dimension}` : ''}{it.processingTimeMs != null ? ` · ${it.processingTimeMs}ms` : ''}{it.bytesSavedPct ? ` · −${it.bytesSavedPct}% bytes` : ''}</span>
                {it.error && <span className="error">{it.error}</span>}
              </li>
            ))}
          </ul>
          {batch.failed > 0 && (
            <button onClick={() => dispatch(retryBatch(batch.batchId))}>
              Retry {batch.failed} failed (resumable)
            </button>
          )}
        </div>
      )}
    </section>
  );
}
