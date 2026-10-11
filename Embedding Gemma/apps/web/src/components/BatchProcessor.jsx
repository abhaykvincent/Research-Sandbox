import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { createBatch, fetchBatch, retryBatch, cancelBatch, setBatchId, stopPolling, clearBatch } from '../store/batchSlice.js';
import { blog } from '../utils/debugLog.js';

export default function BatchProcessor() {
  const dispatch = useDispatch();
  const { batchId, batch, status, error, polling } = useSelector((s) => s.batch);
  const [files, setFiles] = useState([]);
  const [dims, setDims] = useState(768);
  const [concurrency, setConcurrency] = useState(4);
  const [resumeId, setResumeId] = useState('');
  const timer = useRef(null);
  const prevStatus = useRef(new Map()); // jobId -> status, to log transitions only
  const pollCount = useRef(0);
  const lastProgress = useRef('');

  // Poll while processing — idempotent: clear any leaked interval before
  // starting (StrictMode double-mount + re-runs otherwise stack intervals
  // and double/triple the request rate seen in the console logs).
  useEffect(() => {
    if (!polling || !batchId) return undefined;
    if (timer.current) clearInterval(timer.current);
    pollCount.current = 0;
    blog.log(`polling START (1.5s interval)`, { batchId: batchId.slice(0, 8) });
    dispatch(fetchBatch(batchId));
    timer.current = setInterval(() => {
      pollCount.current += 1;
      blog.log(`poll tick #${pollCount.current}`, { batchId: batchId.slice(0, 8) });
      dispatch(fetchBatch(batchId));
    }, 1500);
    return () => {
      clearInterval(timer.current);
      timer.current = null;
    };
  }, [polling, batchId, dispatch]);

  // Resume last batch on load (resumability)
  useEffect(() => {
    if (batchId && !batch) {
      blog.log('resume on load', { batchId: batchId.slice(0, 8), stored: !!localStorage.getItem('fotoflow-last-batch') });
      dispatch(fetchBatch(batchId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Log batch-level + per-item transitions (the actual debugger)
  useEffect(() => {
    if (!batch) return;
    const sig = `${batch.status}|ok=${batch.completed}|fail=${batch.failed}|pend=${batch.pending}`;
    if (sig !== lastProgress.current) {
      lastProgress.current = sig;
      blog.log(`batch ${batch.batchId.slice(0, 8)}: ${sig} (${batch.items?.length ?? 0} items)`);
    }
    if (['succeeded', 'completed_with_errors', 'failed', 'cancelled'].includes(batch.status)) {
      const slow = (batch.items ?? []).filter((i) => (i.processingTimeMs ?? 0) > 10000);
      if (slow.length) blog.warn('slow items (>10s)', slow.map((i) => ({ file: i.fileName, ms: i.processingTimeMs })));
      if (batch.status !== 'succeeded') blog.warn(`batch ended: ${batch.status}`, { failed: batch.failed });
      else blog.log(`batch DONE in ${pollCount.current} polls`);
    }
    for (const it of batch.items ?? []) {
      const prev = prevStatus.current.get(it.jobId);
      if (prev !== it.status) {
        prevStatus.current.set(it.jobId, it.status);
        if (it.status === 'failed') blog.error(`item FAILED: ${it.fileName}`, { error: it.error, attempts: it.attempts, ms: it.processingTimeMs });
        else blog.log(`item ${prev ?? '?'} → ${it.status}: ${it.fileName}`, it.status === 'succeeded'
          ? { dim: it.dimension, ms: it.processingTimeMs, cached: it.cacheHit, savedPct: it.bytesSavedPct }
          : undefined);
      }
    }
  }, [batch]);

  // Surface slice errors loudly
  useEffect(() => {
    if (error) blog.error('slice error', { error, status, batchId: batchId?.slice(0, 8) });
  }, [error, status, batchId]);

  const onFiles = (e) => {    const picked = Array.from(e.target.files ?? []).slice(0, 50);
    setFiles(picked);
    prevStatus.current.clear();
    lastProgress.current = '';
    blog.group(`selected ${picked.length} files`, () => {
      console.log(picked.map((f) => ({ name: f.name, kb: (f.size / 1024).toFixed(1), type: f.type || '(no type!)' })));
      const bad = picked.filter((f) => !/^image\/(jpeg|png|webp)/.test(f.type));
      if (bad.length) console.warn('⚠️ non-standard types (server also accepts heic/heif):', bad.map((f) => f.name));
      const empty = picked.filter((f) => f.size === 0);
      if (empty.length) console.error('❌ zero-byte files (will fail):', empty.map((f) => f.name));
    });
  };
  const done = (batch?.completed ?? 0) + (batch?.failed ?? 0) + (batch?.items?.filter((i) => i.status === 'cancelled').length ?? 0);
  const pct = batch?.total ? Math.round((done / batch.total) * 100) : 0;
  const cancelledCount = batch?.items?.filter((i) => i.status === 'cancelled').length ?? 0;

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
          onClick={() => {
            blog.log('Process clicked', { n: files.length, dims, concurrency });
            dispatch(createBatch({ files, outputDimensionality: dims, concurrency }));
          }}
        >
          {status === 'uploading' ? 'Uploading…' : `Process ${files.length} photos`}
        </button>
      </div>
      {files.length > 0 && <p className="muted">{files.length} selected (first: {files[0].name})</p>}

      <div className="row resume">
        <input placeholder="paste batchId to resume" value={resumeId} onChange={(e) => setResumeId(e.target.value)} />
        <button onClick={() => {
          if (!resumeId) { blog.warn('Resume clicked with empty id'); return; }
          blog.log('Resume clicked', { id: resumeId.slice(0, 12) });
          dispatch(setBatchId(resumeId));
          dispatch(fetchBatch(resumeId));
        }}>
          Resume job
        </button>
        {batchId && <span className="muted">current: <code>{batchId.slice(0, 8)}</code></span>}
      </div>

      {error && <p className="error">Error: {error}</p>}

      {batch && (
        <div className="batch">
          <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
          <p className="muted">
            {batch.status} · {batch.completed}/{batch.total} ok · {batch.failed} failed · {batch.pending} pending{cancelledCount > 0 && ` · ${cancelledCount} cancelled`} · {pct}%
            {batch.items?.some((i) => i.cacheHit) && ' · cache hits ✓'}
          </p>
          <div className="row">
            {(polling || ['queued', 'processing', 'cancelling'].includes(batch.status)) && (
              <button
                disabled={status === 'cancelling' || batch.status === 'cancelling'}
                onClick={() => {
                  blog.log('Cancel clicked', { batchId: batch.batchId.slice(0, 8) });
                  dispatch(cancelBatch(batch.batchId));
                }}
              >
                {batch.status === 'cancelling' || status === 'cancelling' ? 'Cancelling…' : 'Cancel job'}
              </button>
            )}
            {polling && (
              <button onClick={() => dispatch(stopPolling())}>
                Stop watching
              </button>
            )}
            {!polling && (
              <button onClick={() => dispatch(clearBatch())}>
                Dismiss
              </button>
            )}
          </div>
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
            <button onClick={() => {
              blog.log('Retry clicked', { batchId: batch.batchId.slice(0, 8), failed: batch.failed });
              dispatch(retryBatch(batch.batchId));
            }}>
              Retry {batch.failed} failed (resumable)
            </button>
          )}
        </div>
      )}
    </section>
  );
}
