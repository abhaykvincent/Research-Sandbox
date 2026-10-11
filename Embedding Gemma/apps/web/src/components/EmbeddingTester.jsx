import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { checkHealth, embedImage, clearCurrent } from '../store/embeddingSlice.js';

export default function EmbeddingTester() {
  const dispatch = useDispatch();
  const { health, healthStatus, current, status, error, jobs } = useSelector(
    (s) => s.embedding,
  );
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [dims, setDims] = useState(768);

  useEffect(() => {
    dispatch(checkHealth());
  }, [dispatch]);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onSubmit = (e) => {
    e.preventDefault();
    if (!file) return;
    dispatch(clearCurrent());
    dispatch(embedImage({ file, outputDimensionality: Number(dims), includeVector: false }));
  };

  return (
    <section className="card">
      <h2>Milestone 2 — Single-image embedding test</h2>
      <p className="muted">
        Select a JPEG → generate an embedding securely via <code>/api/embeddings</code> → inspect
        dimension + timing. Full vectors stay server-side unless explicitly requested.
      </p>

      <div className="health">
        API:{' '}
        {healthStatus === 'succeeded' ? (
          <span className="ok">
            ● online ({health?.model}, key: {health?.hasKey ? 'set' : 'missing'})
          </span>
        ) : (
          <span className="warn">● {healthStatus} — is services/api running on :5050?</span>
        )}
      </div>

      <form onSubmit={onSubmit} className="row">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <label>
          dims
          <select value={dims} onChange={(e) => setDims(e.target.value)}>
            <option value={128}>128</option>
            <option value={768}>768 (recommended)</option>
            <option value={1536}>1536</option>
            <option value={3072}>3072</option>
          </select>
        </label>
        <button type="submit" disabled={!file || status === 'loading'}>
          {status === 'loading' ? 'Embedding…' : 'Generate embedding'}
        </button>
      </form>

      {preview && (
        <div className="preview">
          <img src={preview} alt="selected test" />
          <div className="meta">{file?.name} · {(file?.size / 1024).toFixed(1)} KB</div>
        </div>
      )}

      {status === 'loading' && <p className="muted">Calling Gemini Embedding 2…</p>}
      {status === 'failed' && <p className="error">Error: {error}</p>}

      {current && status === 'succeeded' && (
        <div className="result">
          <h3>Result</h3>
          <dl>
            <dt>jobId</dt>
            <dd><code>{current.jobId}</code></dd>
            <dt>dimension</dt>
            <dd><strong>{current.dimension}</strong></dd>
            <dt>processing time</dt>
            <dd>{current.processingTimeMs} ms</dd>
            <dt>upload optimized</dt>
            <dd>{current.sizeBytes != null && current.sentBytes != null
              ? `${(current.sizeBytes / 1024).toFixed(1)} KB → ${(current.sentBytes / 1024).toFixed(1)} KB${current.bytesSavedPct ? ` (−${current.bytesSavedPct}%)` : ''}${current.resized ? ' · resized' : ''}`
              : '—'}</dd>
            <dt>model</dt>
            <dd>{current.model}</dd>
            <dt>vector preview (first 12)</dt>
            <dd><code className="vec">{current.vectorPreview?.map((v) => v.toFixed(4)).join(', ')}</code></dd>
          </dl>
          <p className="muted">Success criterion: photo → embedding → inspect → repeat. Log several photos below.</p>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="history">
          <h3>Session history ({jobs.length})</h3>
          <ul>
            {jobs.map((j) => (
              <li key={j.jobId}>
                {j.fileName} — dim {j.dimension} — {j.processingTimeMs} ms —{' '}
                <code>{j.jobId.slice(0, 8)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
